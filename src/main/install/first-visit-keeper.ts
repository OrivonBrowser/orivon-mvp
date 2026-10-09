// What keeps an app that was allowed and is not yet pinned (ADR-0075): the hooks the live handler reports to, the taking
// away of the origin on bad data, the following of the app to its next version, and the background download of the
// version being served. One of these stands behind an app let in on Allow, and behind one served again after a restart.
// No Electron: the tabs and the question come in through `FirstVisitDeps`.

import type { FirstManifestApp } from '../../loader/index.js'
import type { BadData, LiveHooks, LiveVersion } from '../../loader/serve/live-serve.js'
import { applyInstallConsent, askInstallConsent } from '../consent/install-consent-ask.js'
import type { BackgroundOutcome, FirstVisitDeps, SetupSheet } from './first-visit.js'
import { judgeBundle } from './first-visit-decisions.js'
import { revokeAllGrants } from './revoke-all-grants.js'
import type { Entry } from './first-visit.js'

/** After a tab is let in, the download of the whole app waits this long, so the first page has the connection to itself. */
const BACKGROUND_DELAY_MS = 3_000

async function sleep (ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return
  await new Promise<void>((resolve) => {
    const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}

/**
 * What keeps an app that was allowed and is not yet pinned: the hooks the live handler reports to, the taking away of
 * the origin on bad data, the following of the app to its next version, and the background download of the version
 * being served. One of these stands behind an app let in on Allow, and behind one served again after a restart.
 */
export interface Keeper {
  readonly hooks: LiveHooks
  /** The tab the visit let in, once it is in, for a block to cover. */
  enteredTab: (tab: object | undefined) => void
  /** Begins the background download, once; the same promise after that. */
  start: () => Promise<BackgroundOutcome>
}

/** One version of the app the person was asked about, as it was read: what is served, and what is pinned when its turn comes. */
export interface Held {
  readonly read: FirstManifestApp
  readonly declaration: Entry['declaration']
  readonly live: LiveVersion
}

export const heldOf = (read: FirstManifestApp, declaration: Entry['declaration']): Held => ({ read, declaration, live: { manifest: read.manifest, declaration, content: read.content?.cid } })

/** Two versions are the same when they name the same root, the same manifest and the same tree. */
const versionKey = (version: LiveVersion): string => JSON.stringify([version.content, version.manifest, version.declaration?.bundleHash])

/** How many times one download looks again for the version that is current before it gives up until the next visit. */
const MAX_REFRESHES = 3

export function createKeeper (deps: FirstVisitDeps, origin: string, hintedUrl: string, first: Held): Keeper {
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
