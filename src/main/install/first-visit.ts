// A published app's first visit (ADR-0075): the person is asked as soon as the manifest is read, with the tree the
// site declares for its files read beside the question. Allow grants at once and sends the tab into the app, whose
// files are loaded on demand and each checked as it is served; the whole bundle is downloaded and pinned in the
// background afterwards. Any file that is not the declared one is bad data: the origin is taken away entirely. Deny
// opens the site as a plain website. No Electron: the tab's screens and its way into the app are the `SetupHost`
// the caller brings.

import { originFromUrl } from '../../broker/policy/origin.js'
import type { Broker } from '../../broker/broker-contracts.js'
import type { FirstDeclaration, FirstManifestApp, Loader, PendingConsent } from '../../loader/index.js'
import type { BadData, LiveHooks, LiveVersion } from '../../loader/serve/live-serve.js'
import { applyInstallConsent, askInstallConsent } from '../consent/install-consent-ask.js'
import type { InstallAsk } from '../consent/install-consent-ask.js'
import type { InstallConsentPrompt, PerCapabilityConsentPrompt } from '../consent/install-consent.js'
import type { DialogCaller } from '../consent/request-grant.js'
import type { DeclinedApps } from './declined-apps.js'
import { judgeBundle, visitKind } from './first-visit-decisions.js'
import { outsideOriginQueue, withOriginQueue } from './origin-queue.js'
import { revokeAllGrants } from './revoke-all-grants.js'

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
  /** Who to ask, in which tab, when a new version of an app asks for more than it was granted. */
  readonly askerFor?: ((origin: string) => DialogCaller | undefined) | undefined
  /** How long after a tab is let in the background download waits, so it begins once the first page is up. */
  readonly backgroundDelayMs?: number | undefined
}

/** What the tab's screen says: the person is being asked, or the declared tree is being read. */
export interface SetupStage {
  readonly kind: 'asking' | 'verifying'
  readonly name: string
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
  /** The first stage may take the running page of an https app down, which is why it is awaited. */
  show: (stage: SetupStage) => void | Promise<void>
  /** Resolves what the person chose; a sheet with no way forward resolves `leave`. */
  sheet: (sheet: SetupSheet) => Promise<'retry' | 'leave'>
  /** The app is let in: the tab goes into it. */
  enter: () => void
  /** The site opens as a plain website: not an app, or the person said no. */
  plain: () => void
  /** The visit ends with the tab showing neither: the screens are taken away. */
  end: () => void
  /** The tab this visit is in, as the opaque value `blocked` is handed back: a tab whose first page failed to load shows no address of the origin, yet is the one that must be covered. */
  tab?: () => object | undefined
}

/** How the background download ended: `pinned`, `blocked` (bad data, the origin was taken away), or `unfinished` (silent; the next visit finishes it). */
export type BackgroundOutcome = 'pinned' | 'blocked' | 'unfinished'

export type FirstVisitResult =
  /** The person said yes and the app is let in (or was, had the tab not left); `background` settles when the download has ended. */
  | { readonly outcome: 'entered', readonly background: Promise<BackgroundOutcome> }
  /** Another visit finished first: the origin is an app Orivon holds now (`settling`: with its download still going), or the person said no there. The host was not used. */
  | { readonly outcome: 'known' | 'declined' | 'settling' }
  | { readonly outcome: 'plain', readonly why: 'website' | 'unread' | 'denied' }
  | { readonly outcome: 'blocked', readonly differing: readonly string[] }
  | { readonly outcome: 'failed', readonly reason: string }
  | { readonly outcome: 'left' }
  | { readonly outcome: 'rejected', readonly reason: string }

/** The longest the first look at an address waits to learn whether it is an app: a page that is no app, or a gateway that is slow, is let through as an ordinary page after this. */
export const MANIFEST_PROBE_MS = 10_000

/** After a tab is let in, the download of the whole app waits this long, so the first page has the connection to itself. */
export const BACKGROUND_DELAY_MS = 3_000

async function sleep (ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return
  await new Promise<void>((resolve) => {
    const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}

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

  // Only the first look is bounded: it is the wait of a page that may turn out to be no app at all.
  const read = await deps.loader.readManifest(hintedUrl, MANIFEST_PROBE_MS)
  if (gone()) return left()
  if (read.kind === 'website') { host.plain(); return { outcome: 'plain', why: 'website' } }
  if (read.kind === 'unread') { host.plain(); return { outcome: 'plain', why: 'unread' } }
  const { name } = read.manifest

  await host.show({ kind: 'asking', name })
  // The declared tree is read beside the question, so it is ready when the person answers.
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
  try {
    const ask = await askInstallConsent(deps.broker, deps.consent, origin, read.manifest, deps.perCapabilityConsent, caller)
    if (ask.outcome === 'left' || gone()) return left()
    if (ask.outcome === 'denied') {
      deps.declined.add(origin)
      host.plain()
      return { outcome: 'plain', why: 'denied' }
    }

    let declaration: FirstDeclaration
    for (;;) {
      if (!declared.done) await host.show({ kind: 'verifying', name })
      declaration = await declared.tree
      if (gone()) return left()
      if (declaration.kind !== 'failed' || declaration.integrity === true) break
      const choice = await host.sheet({ kind: 'download-failed', name, reason: declaration.reason })
      if (choice !== 'retry') { host.end(); return { outcome: 'failed', reason: declaration.reason } }
      declared = track()
    }
    if (declaration.kind === 'mismatch') return await blockBeforeEntry(deps, host, origin, { kind: 'blocked', name, differing: declaration.differing, differingCount: declaration.differing.length, rootMatches: true })
    if (declaration.kind === 'failed') return await blockBeforeEntry(deps, host, origin, { kind: 'blocked', name, differing: [], differingCount: 0, rootMatches: true, invalid: declaration.reason })

    return await letIn(deps, { origin, hintedUrl, read, ask, declaration: declaration.kind === 'declared' ? declaration.declaration : undefined, gone, host })
  } finally {
    signal?.removeEventListener('abort', stopReading)
    reading.abort()
  }
}

/** Files, or a manifest, that are not the declared ones before anything was let in: the warning, and no grant an earlier version of Orivon left. */
async function blockBeforeEntry (deps: FirstVisitDeps, host: SetupHost, origin: string, sheet: Extract<SetupSheet, { kind: 'blocked' }>): Promise<FirstVisitResult> {
  await revokeAllGrants(deps.broker, origin).catch((error: unknown) => { console.error('[first-visit] grants of a blocked app remain', origin, error) })
  await host.sheet(sheet)
  host.end()
  return { outcome: 'blocked', differing: sheet.differing }
}

interface Entry {
  readonly origin: string
  readonly hintedUrl: string
  readonly read: FirstManifestApp
  readonly ask: InstallAsk
  readonly declaration: Extract<FirstDeclaration, { kind: 'declared' }>['declaration'] | undefined
  readonly gone: () => boolean
  readonly host: SetupHost
}

/**
 * What keeps an app that was allowed and is not yet pinned: the hooks the live handler reports to, the taking away of
 * the origin on bad data, the following of the app to its next version, and the background download of the version
 * being served. One of these stands behind an app let in on Allow, and behind one served again after a restart.
 */
interface Keeper {
  readonly hooks: LiveHooks
  /** The tab the visit let in, once it is in, for a block to cover. */
  enteredTab: (tab: object | undefined) => void
  /** Begins the background download, once; the same promise after that. */
  start: () => Promise<BackgroundOutcome>
}

/** One version of the app the person was asked about, as it was read: what is served, and what is pinned when its turn comes. */
interface Held {
  readonly read: FirstManifestApp
  readonly declaration: Entry['declaration']
  readonly live: LiveVersion
}

const heldOf = (read: FirstManifestApp, declaration: Entry['declaration']): Held => ({ read, declaration, live: { manifest: read.manifest, declaration, content: read.content?.cid } })

/** Two versions are the same when they name the same root, the same manifest and the same tree. */
const versionKey = (version: LiveVersion): string => JSON.stringify([version.content, version.manifest, version.declaration?.bundleHash])

/** How many times one download looks again for the version that is current before it gives up until the next visit. */
const MAX_REFRESHES = 3

function createKeeper (deps: FirstVisitDeps, origin: string, hintedUrl: string, first: Held): Keeper {
  const { name } = first.read.manifest
  let ended = false
  let entered: object | undefined
  let started: Promise<BackgroundOutcome> | undefined
  let current = first
  const known = new Map<string, Held>([[versionKey(first.live), first]])
  const stopped = new AbortController()

  /** Everything the app held is taken away, and the origin is forgotten: its next visit is a first visit. Its data stays where it is. */
  const takeAway = async (): Promise<void> => {
    await deps.broker.forgetOrigin(origin).catch(async (error: unknown) => {
      console.error('[first-visit] an app could not be forgotten whole; its grants are revoked instead', origin, error)
      await revokeAllGrants(deps.broker, origin).catch((revokeError: unknown) => { console.error('[first-visit] grants of an app remain', origin, revokeError) })
    })
    await deps.loader.endLive(origin).catch((error: unknown) => { console.error('[first-visit] an app that was taken away is still served', origin, error) })
  }

  // Bad data, from a served file or the background download: the origin is taken away, once.
  const block = async (found: BadData & Partial<Pick<Extract<SetupSheet, { kind: 'blocked' }>, 'rootMatches' | 'differingCount'>>): Promise<void> => {
    if (ended) return
    ended = true
    stopped.abort()
    console.warn(`[orivon] ${origin} was stopped, and everything it was granted taken away: ${found.invalid ?? found.differing.join(', ')}`)
    const sheet: Extract<SetupSheet, { kind: 'blocked' }> = {
      kind: 'blocked',
      name,
      differing: found.differing,
      differingCount: found.differingCount ?? found.differing.length,
      rootMatches: found.rootMatches ?? true,
      ...(found.invalid === undefined ? {} : { invalid: found.invalid })
    }
    // The pages go first, so nothing of the app runs while its grants go; the person reads the warning meanwhile.
    const covering = deps.blocked?.(origin, sheet, entered) ?? { emptied: Promise.resolve(), dismissed: Promise.resolve() }
    await covering.emptied.catch((error: unknown) => { console.error('[first-visit] the pages of a blocked app could not be emptied', origin, error) })
    await takeAway()
    await covering.dismissed.catch((error: unknown) => { console.error('[first-visit] the tabs of a blocked app could not be covered', origin, error) })
  }

  /** The version that is current now, read afresh from the name or the site, when it is not the one `than` names. Never throws. */
  const readCurrent = async (than: Held): Promise<Held | undefined> => {
    try {
      const read = await deps.loader.readManifest(hintedUrl)
      if (read.kind !== 'app') return undefined
      const tree = await deps.loader.readDeclaration(read, stopped.signal)
      // A new manifest its own tree contradicts, or a tree that cannot be read, is no version to follow.
      if (tree.kind === 'failed' || tree.kind === 'mismatch') return undefined
      const next = heldOf(read, tree.kind === 'declared' ? tree.declaration : undefined)
      if (versionKey(next.live) === versionKey(than.live)) return undefined
      const held = known.get(versionKey(next.live)) ?? next
      known.set(versionKey(held.live), held)
      return held
    } catch (error) {
      console.error('[first-visit] the current version of an app could not be read', origin, error)
      return undefined
    }
  }

  /** A person who was asked about an app is asked only about what its new version declares beyond what they hold. */
  const askForMore = async (held: Held): Promise<void> => {
    const ask = await askInstallConsent(deps.broker, deps.consent, origin, held.read.manifest, deps.perCapabilityConsent, deps.askerFor?.(origin))
    await applyInstallConsent(deps.broker, origin, held.read.manifest, ask)
  }

  /** The app follows its URL to a new version: the manifest is registered, the consent kept for it, the download retargeted. No warning, nothing forgotten. */
  const switchTo = async (next: Held): Promise<void> => {
    if (current === next) return
    current = next
    known.set(versionKey(next.live), next)
    console.log(`[orivon] ${origin} has a new version; it is followed`)
    await deps.broker.registerApp(origin, next.read.manifest).catch((error: unknown) => { console.error('[first-visit] a new version could not be registered', origin, error) })
    await deps.loader.rememberConsent(next.read, next.declaration).catch((error: unknown) => { console.error('[first-visit] the consent could not be kept for a new version', origin, error) })
    // Asked beside the app running, never in front of it.
    void askForMore(next).catch((error: unknown) => { console.error('[first-visit] the question about a new version failed', origin, error) })
  }

  const refresh = async (): Promise<boolean> => {
    const next = await readCurrent(current)
    if (next === undefined) return false
    await switchTo(next)
    return true
  }

  const run = async (): Promise<BackgroundOutcome> => {
    try {
      await sleep(deps.backgroundDelayMs ?? BACKGROUND_DELAY_MS, stopped.signal)
      if (ended) return 'blocked'
      if (await deps.loader.pinFor(origin) !== null) return 'pinned'
      let rechecked = false
      let refreshes = 0
      const refreshed = async (): Promise<boolean> => refreshes++ < MAX_REFRESHES && await refresh()
      for (;;) {
        const { read, declaration } = current
        const bundle = await deps.loader.fetchForInstall(read, hintedUrl, stopped.signal)
        if (ended) {
          if (bundle.ok) await bundle.discard()
          return 'blocked'
        }
        if (!bundle.ok) {
          // Only a failed verification is the content being wrong; every other failure may be a version that came after.
          if (bundle.integrity === true) {
            await block({ differing: [], invalid: bundle.reason })
            return 'blocked'
          }
          if (bundle.tooLarge !== true && await refreshed()) continue
          console.log(`[orivon] the background download of ${origin} did not finish: ${bundle.reason}`)
          return 'unfinished'
        }
        const judgement = judgeBundle(bundle.tree, bundle.declaration)
        if (judgement.kind === 'block') {
          await bundle.discard()
          // An https site may have been deployed while its files came down: look once more before calling it tampering.
          if (bundle.content === undefined && !rechecked) { rechecked = true; continue }
          await block({ differing: judgement.differing, differingCount: judgement.differingCount, rootMatches: judgement.rootMatches })
          return 'blocked'
        }
        // Whole files that match their own tree but not the tree that was allowed are the next version, which is followed.
        if (declaration !== undefined && judgeBundle(bundle.tree, declaration).kind === 'block') {
          await bundle.discard()
          if (await refreshed()) continue
          return 'unfinished'
        }
        const installed = await deps.loader.installFetched(bundle.canonicalOrigin, bundle.manifest, bundle.tree, bundle.entries, bundle.declaration, bundle.content)
        if (installed.outcome === 'installed' && installed.servingFailed !== true) return 'pinned'
        await bundle.discard()
        console.log(`[orivon] the background download of ${origin} could not be pinned`)
        return 'unfinished'
      }
    } catch (error) {
      console.error('[first-visit] the background download failed', origin, error)
      return 'unfinished'
    }
  }

  const start = (): Promise<BackgroundOutcome> => { started ??= run(); return started }
  return {
    hooks: {
      onBadData: (found) => { void block(found) },
      // The handler asks what is current when a name moved or a file is not the one the tree names; the download may already know.
      fresh: async (since) => {
        if (versionKey(current.live) !== versionKey(since)) return current.live
        return (await readCurrent(current))?.live
      },
      adopt: async (version) => {
        const held = known.get(versionKey(version))
        if (held !== undefined) await switchTo(held)
      },
      onServed: () => {}
    },
    enteredTab: (tab) => { entered = tab },
    start
  }
}

/**
 * The person said yes and the tree is known: serve the app, register it, grant what was accepted, send the tab in,
 * remember the consent, and begin the download. The order leaves nothing half-done: serving first (so a failure opens
 * the site as a website with nothing granted), then the registration and grants, then the tab.
 */
async function letIn (deps: FirstVisitDeps, entry: Entry): Promise<FirstVisitResult> {
  const { origin, hintedUrl, read, host } = entry
  const { name } = read.manifest
  const keeper = createKeeper(deps, origin, hintedUrl, heldOf(read, entry.declaration))

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
  try {
    try {
      await deps.broker.registerApp(origin, read.manifest)
    } catch (error) {
      console.error('[first-visit] registerApp failed; the app is registered but its version floor was not persisted', origin, error)
    }
    await applyInstallConsent(deps.broker, origin, read.manifest, entry.ask)
  } catch (error) {
    console.error('[first-visit] the app could not be granted what was accepted', origin, error)
    await deps.broker.forgetOrigin(origin).catch(() => {})
    await deps.loader.endLive(origin).catch(() => {})
    host.plain()
    return { outcome: 'failed', reason: `${name} could not be granted what was accepted` }
  }
  // Durable from here: a restart before the pin serves this very root again, checked, and finishes the pin.
  await deps.loader.rememberConsent(read, entry.declaration).catch((error: unknown) => { console.error('[first-visit] the consent could not be kept for a restart', origin, error) })

  if (entry.gone()) host.end()
  else host.enter()
  keeper.enteredTab(host.tab?.())
  console.log(`[orivon] ${origin} is let in as an app; its files follow in the background`)
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
  await deps.broker.registerApp(origin, read.manifest).catch((error: unknown) => { console.error('[first-visit] a consented app could not be registered again', origin, error) })
  // Until the app is used and its download has ended, the origin reads as settling: the old install path never sees it.
  settling.add(origin)
}

/** What the tab's two ways in need of a first visit: whether an origin is one, and running it. */
export interface FirstVisit {
  /** `settling`: let in as an app, with its download still going. */
  kindOf: (origin: string) => Promise<'first' | 'declined' | 'known' | 'settling'>
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

export function createFirstVisit (options: FirstVisitOptions): FirstVisit {
  const { deps } = options
  const settling = new Set<string>()

  async function kindOf (origin: string): Promise<'first' | 'declined' | 'known' | 'settling'> {
    if (settling.has(origin)) return 'settling'
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
    return await withOriginQueue(origin, async () => {
      const kind = await kindOf(origin)
      if (kind !== 'first') return { outcome: kind }
      const result = await runFirstVisit(deps, origin, hintedUrl, caller, host, signal)
      if (result.outcome === 'entered') {
        // The download holds the origin's queue after the visit has returned, so nothing installs the same files beside it.
        // An app whose download did not finish stays settling for the run: the ordinary install path, which checks no
        // file, never takes it over; its consent is kept, and the next start serves it again.
        settling.add(origin)
        void outsideOriginQueue(async () => await withOriginQueue(origin, async () => await result.background)).then((outcome) => { if (outcome !== 'unfinished') settling.delete(origin) })
      }
      return result
    })
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
