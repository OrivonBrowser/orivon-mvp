// A published app's first visit (ADR-0075, ADR-0076): the page loads at once as an ordinary website, with no grant. The
// manifest is read beside it and the person is asked as soon as it is; from that same moment the app is cached (the
// declared tree read, every file downloaded and checked, kept staged), whatever the answer will be. Allow grants, serves
// the app checked, pins what was staged and reloads the tab as the app; Deny keeps the plain website and stops the
// caching. Any file that is not the declared one is bad data: the page is stopped and the origin taken away. No
// Electron: the tab's screens and its way into the app are the `SetupHost` the caller brings.

import { originFromUrl } from '../../broker/policy/origin.js'
import type { Broker } from '../../broker/broker-contracts.js'
import type { FirstDeclaration, FirstManifestApp, Loader, PendingConsent } from '../../loader/index.js'
import type { BadData, LiveHooks, LiveVersion } from '../../loader/serve/live-serve.js'
import { applyInstallConsent, askInstallConsent } from '../consent/install-consent-ask.js'
import type { InstallAsk } from '../consent/install-consent-ask.js'
import type { InstallConsentPrompt, PerCapabilityConsentPrompt } from '../consent/install-consent.js'
import type { DialogCaller } from '../consent/request-grant.js'
import type { CapabilityPromptPrompt } from '../consent/update-outcomes.js'
import type { DeclinedApps } from './declined-apps.js'
import { judgeBundle, visitKind } from './first-visit-decisions.js'
import { outsideOriginQueue, withOriginQueue } from './origin-queue.js'
import { createKeeper, heldOf } from './first-visit-keeper.js'
import type { Keeper } from './first-visit-keeper.js'

/** What a block does to the pages of an app: see `FirstVisitDeps.blocked`. */
export interface Blocking {
  readonly emptied: Promise<void>
  readonly dismissed: Promise<void>
}

export interface FirstVisitDeps {
  readonly broker: Broker
  readonly loader: Pick<Loader, 'readManifest' | 'readDeclaration' | 'serveLive' | 'endLive' | 'rememberConsent' | 'pendingConsents' | 'fetchForInstall' | 'installFetched' | 'pinFor'>
  readonly consent?: InstallConsentPrompt | undefined
  readonly perCapabilityConsent?: PerCapabilityConsentPrompt | undefined
  /** The origins whose question was answered Deny: written by a pressed Deny and by nothing else. */
  readonly declined: Pick<DeclinedApps, 'has' | 'add'>
  /**
   * Empties every open tab of an origin, and `entered` (the tab this visit let in), closes the other pages of its
   * partition, and covers the tabs with a sheet, when bad data is found after they were let in. `emptied` settles once
   * nothing of the app runs any more; `dismissed` once the person has read the sheet.
   */
  readonly blocked?: ((origin: string, sheet: SetupSheet, entered: object | undefined) => Blocking) | undefined
  /** The question a pinned app's update asks when it wants more than it holds, asked of a new version of an app that is not yet pinned; "keep the current version" is a no. Without it a widened version is never followed. */
  readonly capabilityPrompt?: CapabilityPromptPrompt | undefined
  /** Who to ask, in which tab, when a new version of an app asks for more than it was granted. */
  readonly askerFor?: ((origin: string) => DialogCaller | undefined) | undefined
  /** How long after a tab is let in the background download waits, so it begins once the first page is up. */
  readonly backgroundDelayMs?: number | undefined
}

/**
 * A sheet over the tab. `blocked` has no way forward: a file is not the one the site declared, or the verifier
 * proved the content not what its address names (`invalid`). `download-failed` offers Try again.
 */
export type SetupSheet =
  | {
    readonly kind: 'blocked'
    readonly name: string
    readonly differing: readonly string[]
    readonly differingCount: number
    readonly rootMatches: boolean
    /** The verifier's own reason, set when the files could not be verified rather than differing from a declaration. */
    readonly invalid?: string
  }
  | { readonly kind: 'download-failed', readonly name: string, readonly reason: string }

/** The tab a first visit happens in. */
export interface SetupHost {
  /** Resolves what the person chose; a sheet with no way forward resolves `leave`. */
  sheet: (sheet: SetupSheet) => Promise<'retry' | 'leave'>
  /** The app is let in: the tab reloads as the app. */
  enter: () => void
  /** The site stays the plain website the tab already shows: not an app, or the person said no. */
  plain: () => void
  /** The visit ends with the tab showing neither: the screens are taken away. */
  end: () => void
  /** The tab this visit is in, as the opaque value `blocked` is handed back: a tab whose first page failed to load shows no address of the origin, yet is the one that must be covered. */
  tab?: () => object | undefined
}

/** How the download ended: `pinned`, `blocked` (bad data, the origin was taken away), or `unfinished` (silent; the next visit finishes it). */
export type BackgroundOutcome = 'pinned' | 'blocked' | 'unfinished'

export type FirstVisitResult =
  /** The person said yes and the app is let in (or was, had the tab not left); `background` settles when the download has ended. */
  | { readonly outcome: 'entered', readonly background: Promise<BackgroundOutcome> }
  /** Another visit finished first: the origin is an app Orivon holds now (`settling`: with its download still going), or the person said no there. The host was not used. */
  | { readonly outcome: 'known' | 'declined' | 'settling' }
  /** The person dismissed the question (Escape, a timeout): nothing is recorded, and for the rest of the run the origin is not asked about again. The staged cache is kept for as long. */
  | { readonly outcome: 'later', readonly keeper?: Keeper }
  /** The same tab already has a visit to this origin running (a reload, the page's own hint): this one was dropped. */
  | { readonly outcome: 'duplicate' }
  | { readonly outcome: 'plain', readonly why: 'website' | 'unread' | 'denied' }
  | { readonly outcome: 'blocked', readonly differing: readonly string[] }
  | { readonly outcome: 'failed', readonly reason: string }
  | { readonly outcome: 'left' }
  | { readonly outcome: 'rejected', readonly reason: string }

/** The longest the first look at an address waits to learn whether it is an app: a page that is no app, or a gateway that is slow, is let through as an ordinary page after this. */
export const MANIFEST_PROBE_MS = 10_000

/**
 * Runs one first visit to `hintedUrl`, whose origin must be `hintingOrigin`. Never rejects. `signal` ends the
 * visit's own reads when the tab closes or leaves; it does not stop the download after entry, which belongs to the
 * app the person allowed. A tab is entered only if it is still where the visit began.
 */
export async function runFirstVisit (deps: FirstVisitDeps, hintingOrigin: string, hintedUrl: string, caller: DialogCaller | undefined, host: SetupHost, signal?: AbortSignal): Promise<FirstVisitResult> {
  const origin = originFromUrl(hintedUrl)
  if (origin === null) return { outcome: 'rejected', reason: `hintedUrl is not a valid app origin: ${hintedUrl}` }
  if (hintingOrigin !== origin) return { outcome: 'rejected', reason: `a hint from ${hintingOrigin} may only install its own origin's app, not ${origin}` }

  const gone = (): boolean => signal?.aborted === true || (caller !== undefined && !caller.stillOn(origin))
  const left = (): FirstVisitResult => { host.end(); return { outcome: 'left' } }

  // The page is already on screen. The first look at the manifest is bounded only because the page may turn out to be no app at all.
  const read = await deps.loader.readManifest(hintedUrl, MANIFEST_PROBE_MS)
  if (gone()) return left()
  if (read.kind === 'website') { host.plain(); return { outcome: 'plain', why: 'website' } }
  if (read.kind === 'unread') { host.plain(); return { outcome: 'plain', why: 'unread' } }
  const { name } = read.manifest

  // From here, beside the question: the app is cached, and the tree it declares is read.
  const keeper = createKeeper(deps, origin, hintedUrl, heldOf(read, undefined))
  keeper.cache()
  const reading = new AbortController()
  const stopReading = (): void => { reading.abort() }
  signal?.addEventListener('abort', stopReading, { once: true })
  const track = (): { done: boolean, tree: Promise<FirstDeclaration> } => {
    const started = deps.loader.readDeclaration(read, reading.signal)
    const tracked = { done: false, tree: started.catch((error: unknown): FirstDeclaration => ({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) })) }
    void tracked.tree.then(() => { tracked.done = true })
    return tracked
  }
  let declared = track()
  // A manifest its own tree contradicts, or content the verifier proves wrong, is known before the answer: the page stops now.
  void declared.tree.then(async (tree) => {
    if (tree.kind === 'mismatch') await keeper.block({ differing: tree.differing })
    else if (tree.kind === 'failed' && tree.integrity === true) await keeper.block({ differing: [], invalid: tree.reason })
  })
  let entered = false
  let notNow = false
  try {
    // The page keeps running while the question is open, and the question goes when the app is stopped or the tab leaves the origin.
    const withdrawn = signal === undefined ? keeper.signal : AbortSignal.any([keeper.signal, signal])
    const ask = await askInstallConsent(deps.broker, deps.consent, origin, read.manifest, deps.perCapabilityConsent, caller === undefined ? undefined : { ...caller, signal: withdrawn, unheld: true })
    if (keeper.stopped()) return left()
    if (gone()) return left()
    if (ask.outcome === 'left') {
      notNow = true
      host.end()
      return { outcome: 'later', keeper }
    }
    if (ask.outcome === 'denied') {
      deps.declined.add(origin)
      host.plain()
      return { outcome: 'plain', why: 'denied' }
    }

    let declaration: FirstDeclaration
    for (;;) {
      declaration = await declared.tree
      if (keeper.stopped()) return left()
      if (gone()) return left()
      if (declaration.kind !== 'failed' || declaration.integrity === true) break
      const choice = await host.sheet({ kind: 'download-failed', name, reason: declaration.reason })
      if (choice !== 'retry') { host.end(); return { outcome: 'failed', reason: declaration.reason } }
      declared = track()
    }
    // A manifest its own tree contradicts, or content the verifier proved wrong, has already stopped the page (above).
    if (declaration.kind === 'mismatch' || declaration.kind === 'failed') return left()

    const result = await letIn(deps, { origin, hintedUrl, read, ask, declaration: declaration.kind === 'declared' ? declaration.declaration : undefined, gone, host, keeper })
    entered = result.outcome === 'entered'
    return result
  } finally {
    signal?.removeEventListener('abort', stopReading)
    reading.abort()
    // Whatever was cached for an app nobody let in is thrown away.
    if (!entered && !notNow) await keeper.cancel()
  }
}

export interface Entry {
  readonly origin: string
  readonly hintedUrl: string
  readonly read: FirstManifestApp
  readonly ask: InstallAsk
  readonly declaration: Extract<FirstDeclaration, { kind: 'declared' }>['declaration'] | undefined
  readonly gone: () => boolean
  readonly host: SetupHost
  readonly keeper: Keeper
}

/**
 * The person said yes and the tree is known: serve the app, register it, grant what was accepted, send the tab in,
 * remember the consent, and begin the download. The order leaves nothing half-done: serving first (so a failure opens
 * the site as a website with nothing granted), then the registration and grants, then the tab.
 */
async function letIn (deps: FirstVisitDeps, entry: Entry): Promise<FirstVisitResult> {
  const { origin, read, host, keeper } = entry
  const { name } = read.manifest
  const left = (): FirstVisitResult => { host.end(); return { outcome: 'left' } }
  keeper.declared(entry.declaration)

  // The serving, the registration, the grants and the record are one step as far as a block is concerned: one that lands
  // meanwhile waits for the step's end and then takes it all away, and the step stops at the first sign of it.
  const prepared = await keeper.exclusive(async (): Promise<FirstVisitResult | undefined> => {
    if (keeper.stopped()) return left()
    let served = false
    try {
      served = await deps.loader.serveLive(read, entry.declaration, keeper.hooks)
    } catch (error) {
      console.error('[first-visit] the app could not be served before its pin', origin, error)
    }
    if (!served) {
      host.plain()
      return { outcome: 'failed', reason: `${name} could not be set up to be checked as it loads` }
    }
    keeper.markServed()
    if (keeper.stopped()) return left()
    try {
      try {
        await deps.broker.registerApp(origin, read.manifest)
      } catch (error) {
        console.error('[first-visit] registerApp failed; the app is registered but its version floor was not persisted', origin, error)
      }
      if (keeper.stopped()) return left()
      await applyInstallConsent(deps.broker, origin, read.manifest, entry.ask)
    } catch (error) {
      console.error('[first-visit] the app could not be granted what was accepted', origin, error)
      await deps.broker.forgetOrigin(origin).catch(() => {})
      await deps.loader.endLive(origin).catch(() => {})
      host.plain()
      return { outcome: 'failed', reason: `${name} could not be granted what was accepted` }
    }
    if (keeper.stopped()) return left()
    // Durable from here: a restart before the pin serves this very root again, checked, and finishes the pin.
    await deps.loader.rememberConsent(read, entry.declaration).catch((error: unknown) => { console.error('[first-visit] the consent could not be kept for a restart', origin, error) })
    return undefined
  })
  if (prepared !== undefined) return prepared

  // Staged before the answer: pinned now, so the reload is served from the pin.
  if (keeper.landed()) await keeper.start()
  // A block that landed meanwhile has the tab and takes the origin away; the tab is not sent into it.
  if (keeper.stopped()) return left()
  if (entry.gone()) host.end()
  else host.enter()
  keeper.enteredTab(host.tab?.())
  console.log(`[orivon] ${origin} is let in as an app`)
  return { outcome: 'entered', background: keeper.start() }
}

/**
 * An app that was allowed and whose pin never landed (a restart, a download that did not finish), served again as it
 * was allowed: the consented manifest and tree, every file checked, grants as they were saved. Its pin resumes, for that
 * root, when the app is first used. Never the old install path.
 */
async function resumeConsent (deps: FirstVisitDeps, consent: PendingConsent, settling: Set<string>): Promise<void> {
  const { read, declaration } = consent
  const origin = read.canonicalOrigin
  const keeper = createKeeper(deps, origin, `${origin}/`, heldOf(read, declaration))
  // Its download holds the origin's queue while it runs, so a page's own hint installs nothing beside it.
  const hooks: LiveHooks = {
    ...keeper.hooks,
    onServed: () => { void outsideOriginQueue(async () => await withOriginQueue(origin, async () => await keeper.start())).then((outcome) => { if (outcome !== 'unfinished') settling.delete(origin) }) }
  }
  const served = await deps.loader.serveLive(read, declaration, hooks).catch((error: unknown) => {
    console.error('[first-visit] a consented app could not be served again', origin, error)
    return false
  })
  if (!served) return
  keeper.markServed()
  await deps.broker.registerApp(origin, read.manifest).catch((error: unknown) => { console.error('[first-visit] a consented app could not be registered again', origin, error) })
  // Until the app is used and its download has ended, the origin reads as settling: the old install path never sees it.
  settling.add(origin)
}

/** What the tab's two ways in need of a first visit: whether an origin is one, and running it. */
export interface FirstVisit {
  /** `settling`: let in as an app, with its download still going. `later`: the question was dismissed this run. */
  kindOf: (origin: string) => Promise<'first' | 'declined' | 'known' | 'settling' | 'later'>
  /** Serialised per origin, and judged again when its turn comes: two tabs on one origin ask once. `signal` ends the visit's own reads. */
  run: (origin: string, hintedUrl: string, caller: DialogCaller | undefined, host: SetupHost, signal?: AbortSignal) => Promise<FirstVisitResult>
  /** At start: serves again every app that was allowed and not yet pinned, before any tab can ask for it. */
  resume: () => Promise<void>
}

export interface FirstVisitOptions {
  readonly deps: FirstVisitDeps
  /** True for an origin the first visit never applies to: a local file, a loopback or developer origin, anything not https. */
  readonly untouched: (origin: string) => boolean
  /** The origin runs in a partition of its own, served from its pin or from the verifier. */
  readonly servedFromCache: (origin: string) => boolean
}

/** Two references to a tab are one tab when they name the same window and tab id, whatever the objects holding them. */
const sameTab = (a: object | undefined, b: object): boolean => a !== undefined && Object.entries(b).every(([key, value]) => (a as Record<string, unknown>)[key] === value)

export function createFirstVisit (options: FirstVisitOptions): FirstVisit {
  const { deps } = options
  const settling = new Set<string>()
  /** Origins whose question was dismissed this run, with the cache each kept staged. Nothing of this is written down. */
  const notNow = new Map<string, Keeper | undefined>()
  /** The visits running, by origin and tab: a reload or the page's own hint in a tab that is already being asked is the same visit. */
  const running: Array<{ origin: string, tab: object | undefined }> = []

  async function kindOf (origin: string): Promise<'first' | 'declined' | 'known' | 'settling' | 'later'> {
    if (settling.has(origin)) return 'settling'
    if (notNow.has(origin)) return 'later'
    if (options.untouched(origin) || deps.broker.app.isRegisteredSync(origin) || options.servedFromCache(origin)) return 'known'
    return visitKind({
      registered: false,
      pinned: await deps.loader.pinFor(origin) !== null,
      versionFloor: await deps.broker.versionFloorFor(origin),
      declined: deps.declined.has(origin)
    })
  }

  async function run (origin: string, hintedUrl: string, caller: DialogCaller | undefined, host: SetupHost, signal?: AbortSignal): Promise<FirstVisitResult> {
    const canonical = originFromUrl(hintedUrl)
    if (canonical === null || canonical !== origin) return await runFirstVisit(deps, origin, hintedUrl, caller, host, signal)
    const tab = host.tab?.()
    if (tab !== undefined && running.some((visit) => visit.origin === origin && sameTab(visit.tab, tab))) return { outcome: 'duplicate' }
    const mine = { origin, tab }
    running.push(mine)
    return await withOriginQueue(origin, async () => {
      const kind = await kindOf(origin)
      if (kind !== 'first') return { outcome: kind }
      const result = await runFirstVisit(deps, origin, hintedUrl, caller, host, signal)
      if (result.outcome === 'later') notNow.set(origin, result.keeper)
      if (result.outcome === 'entered') {
        // The download holds the origin's queue after the visit has returned, so nothing installs the same files beside it.
        // An app whose download did not finish stays settling for the run: the ordinary install path, which checks no
        // file, never takes it over; its consent is kept, and the next start serves it again.
        settling.add(origin)
        void outsideOriginQueue(async () => await withOriginQueue(origin, async () => await result.background)).then((outcome) => { if (outcome !== 'unfinished') settling.delete(origin) })
      }
      return result
    }).finally(() => { running.splice(running.indexOf(mine), 1) })
  }

  async function resume (): Promise<void> {
    for (const consent of await deps.loader.pendingConsents()) {
      const origin = consent.read.canonicalOrigin
      if (options.untouched(origin) || deps.broker.app.isRegisteredSync(origin) || settling.has(origin)) continue
      await resumeConsent(deps, consent, settling)
    }
  }

  return { kindOf, run, resume }
}
