// What keeps an app that is being asked about, allowed and not yet pinned (ADR-0075, ADR-0076): the caching that begins
// when its manifest is read, before the question is answered; the hooks the live handler reports to; the taking away of the
// origin on bad data; the following of the app to its next version; and the pin of the version being served. One of these
// stands behind a first visit, and behind an app served again after a restart.
// No Electron: the tabs and the question come in through `FirstVisitDeps`.

import type { FirstBundle, FirstManifestApp } from '../../loader/index.js'
import type { BadData, LiveHooks, LiveVersion } from '../../loader/serve/live-serve.js'
import type { CapabilityKind } from '../../contracts/index.js'
import { decideUpdate, patternSetFromGrants } from '../../broker/policy/update.js'
import { patternSetFromCapabilities, widensInvisibleLimits, withoutSwitchedOffCapabilities } from '../../broker/policy/manifest-patterns.js'
import { grantChangedCapabilities } from '../consent/grant-changed-capabilities.js'
import type { BackgroundOutcome, FirstVisitDeps, SetupSheet } from './first-visit.js'
import { judgeBundle } from './first-visit-decisions.js'
import { revokeAllGrants } from './revoke-all-grants.js'
import type { Entry } from './first-visit.js'

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
  /** The tree the site declares, once it is read: what the app being asked about is held to from here. */
  declared: (declaration: Entry['declaration']) => void
  /** The live handler is serving the origin: a block has a handler and a registration to take away. */
  markServed: () => void
  /**
   * From the moment the manifest is read, and before the question is answered: downloads the whole app, checks it against
   * the tree it comes with, and keeps it staged. Nothing is granted, served or pinned by it. Once.
   */
  cache: () => void
  /** The staged app is whole and waiting for the answer. */
  landed: () => boolean
  /** The caching ended in bad data, or the app was taken away: nothing more is to be done with this visit. */
  stopped: () => boolean
  /** Aborts when the app is blocked or the visit ends: a question still open about it is withdrawn. */
  readonly signal: AbortSignal
  /** Bad data found before anything was asked of the tree: stops the page and shows the warning. */
  block: (found: BadData) => Promise<void>
  /** The answer is no, or the tab left: stops the caching and discards what was staged. */
  cancel: () => Promise<void>
  /** The answer is yes: pins what was staged, or downloads and pins; once, the same promise after that. */
  start: () => Promise<BackgroundOutcome>
}

/** What caching ends in: the whole app, staged and judged, or an outcome with nothing staged. */
type Step = { readonly kind: 'whole', readonly bundle: Extract<FirstBundle, { ok: true }> } | { readonly kind: 'done', readonly outcome: BackgroundOutcome }

/** One version of the app the person was asked about, as it was read: what is served, and what is pinned when its turn comes. */
export interface Held {
  readonly read: FirstManifestApp
  readonly declaration: Entry['declaration']
  readonly live: LiveVersion
}

export const heldOf = (read: FirstManifestApp, declaration: Entry['declaration']): Held => ({ read, declaration, live: { manifest: read.manifest, declaration, content: read.content?.cid } })

/** Two versions are the same when they name the same root, the same manifest and the same tree. */
const versionKey = (version: LiveVersion): string => JSON.stringify([version.content, version.manifest, version.declaration?.bundleHash])

/** `decideUpdate` is asked about authority alone: the bundle is taken as the same, so only widening decides. */
const SAME_BUNDLE = 'sha256:0'

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
  // Until the answer is yes nothing is granted, so the version being cached is not followed to another: a move found then
  // only ends the caching, and the download after the answer looks again.
  let allowed = false
  let cancelled = false
  let served = false
  let precache: Promise<Step> | undefined
  let precached = false

  /** Everything the app held is taken away, and the origin is forgotten: its next visit is a first visit. Its data stays where it is. */
  const takeAway = async (): Promise<void> => {
    await deps.broker.forgetOrigin(origin).catch(async (error: unknown) => {
      console.error('[first-visit] an app could not be forgotten whole; its grants are revoked instead', origin, error)
      await revokeAllGrants(deps.broker, origin).catch((revokeError: unknown) => { console.error('[first-visit] grants of an app remain', origin, revokeError) })
    })
    if (served) await deps.loader.endLive(origin).catch((error: unknown) => { console.error('[first-visit] an app that was taken away is still served', origin, error) })
  }

  // Bad data, from a served file or the background download: the origin is taken away, once.
  const block = async (found: BadData & Partial<Pick<Extract<SetupSheet, { kind: 'blocked' }>, 'rootMatches' | 'differingCount'>>): Promise<void> => {
    if (ended) return
    ended = true
    stopped.abort()
    console.warn(`[orivon] ${origin} was stopped, and nothing it was granted remains: ${found.invalid ?? found.differing.join(', ')}`)
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

  /**
   * Whether a new version may be served without asking: it declares nothing beyond what is held. The same decision a pinned
   * app's update takes (`decideUpdate`'s widening check, plus the three limits it cannot see), made before anything of the
   * new version is registered. `'refuse'` is a version older than the floor, which is no update.
   */
  const needsQuestion = async (next: Held): Promise<'none' | 'ask' | 'refuse'> => {
    const manifest = next.read.manifest
    const held = patternSetFromGrants(await deps.broker.app.grants(origin))
    const declared = withoutSwitchedOffCapabilities(patternSetFromCapabilities(manifest.capabilities), held, await deps.broker.declinedCapabilitiesFor(origin))
    const decision = decideUpdate({
      pinnedHash: SAME_BUNDLE,
      newHash: SAME_BUNDLE,
      grantedPatterns: held,
      newPatterns: declared,
      version: manifest.version,
      versionFloor: await deps.broker.versionFloorFor(origin),
      rollbackAcknowledged: false,
      previouslyDeclaredPatterns: patternSetFromCapabilities(current.read.manifest.capabilities)
    })
    if (decision === 'rollback-choice') return 'refuse'
    return decision === 'capability-prompt' || widensInvisibleLimits(current.read.manifest.capabilities, manifest.capabilities) ? 'ask' : 'none'
  }

  /** What the person is asked when a new version declares more: the question a pinned app's update asks, with its answer "keep the current version". */
  const askWidening = async (next: Held): Promise<boolean> => {
    if (deps.capabilityPrompt === undefined) return false
    try {
      return await deps.capabilityPrompt(origin, next.read.manifest, patternSetFromCapabilities(next.read.manifest.capabilities), deps.askerFor?.(origin))
    } catch (error) {
      console.error('[first-visit] the question about a new version threw; the current version is kept', origin, error)
      return false
    }
  }

  const considering = new Map<string, Promise<boolean>>()

  /**
   * The app follows its URL to a new version, unless that asks for more than is held and the person says keep the current
   * one. Nothing of the new version is registered or granted before they answer; the answer is asked once. On yes the
   * manifest is registered, what it declares is granted, the consent is kept for it and the download retargeted.
   */
  const consider = async (next: Held): Promise<boolean> => {
    if (current === next) return true
    const key = versionKey(next.live)
    let settled = considering.get(key)
    if (settled === undefined) {
      settled = (async () => {
        const need = await needsQuestion(next)
        if (need === 'refuse' || (need === 'ask' && !await askWidening(next))) return false
        current = next
        console.log(`[orivon] ${origin} has a new version; it is followed`)
        await deps.broker.registerApp(origin, next.read.manifest).catch((error: unknown) => { console.error('[first-visit] a new version could not be registered', origin, error) })
        if (need === 'ask') {
          // The whole declared set was shown and accepted, so an earlier no is stale (as for a pinned update).
          await deps.broker.clearDeclinedConsent(origin)
          await grantChangedCapabilities(deps.broker, origin, next.read.manifest, Object.keys(patternSetFromCapabilities(next.read.manifest.capabilities)) as readonly CapabilityKind[])
        }
        await deps.loader.rememberConsent(next.read, next.declaration).catch((error: unknown) => { console.error('[first-visit] the consent could not be kept for a new version', origin, error) })
        return true
      })()
      considering.set(key, settled)
    }
    return await settled
  }

  const refresh = async (): Promise<boolean> => {
    const next = await readCurrent(current)
    return next !== undefined && await consider(next)
  }

  /** The whole app downloaded and judged, or why it was not. Never throws. */
  const download = async (): Promise<Step> => {
    try {
      await sleep(deps.backgroundDelayMs ?? 0, stopped.signal)
      if (ended) return { kind: 'done', outcome: 'blocked' }
      if (cancelled) return { kind: 'done', outcome: 'unfinished' }
      if (await deps.loader.pinFor(origin) !== null) return { kind: 'done', outcome: 'pinned' }
      let rechecked = false
      let refreshes = 0
      const refreshed = async (): Promise<boolean> => allowed && refreshes++ < MAX_REFRESHES && await refresh()
      for (;;) {
        const { read, declaration } = current
        const bundle = await deps.loader.fetchForInstall(read, hintedUrl, stopped.signal)
        if (ended || cancelled) {
          if (bundle.ok) await bundle.discard()
          return { kind: 'done', outcome: ended ? 'blocked' : 'unfinished' }
        }
        if (!bundle.ok) {
          // Only a failed verification is the content being wrong; every other failure may be a version that came after.
          if (bundle.integrity === true) {
            await block({ differing: [], invalid: bundle.reason })
            return { kind: 'done', outcome: 'blocked' }
          }
          if (bundle.tooLarge !== true && await refreshed()) continue
          console.log(`[orivon] the download of ${origin} did not finish: ${bundle.reason}`)
          return { kind: 'done', outcome: 'unfinished' }
        }
        const judgement = judgeBundle(bundle.tree, bundle.declaration)
        if (judgement.kind === 'block') {
          await bundle.discard()
          // An https site may have been deployed while its files came down: look once more before calling it tampering.
          if (bundle.content === undefined && !rechecked) { rechecked = true; continue }
          await block({ differing: judgement.differing, differingCount: judgement.differingCount, rootMatches: judgement.rootMatches })
          return { kind: 'done', outcome: 'blocked' }
        }
        // Whole files that match their own tree but not the tree that was allowed are the next version, which is followed.
        if (declaration !== undefined && judgeBundle(bundle.tree, declaration).kind === 'block') {
          await bundle.discard()
          if (await refreshed()) continue
          return { kind: 'done', outcome: 'unfinished' }
        }
        return { kind: 'whole', bundle }
      }
    } catch (error) {
      console.error('[first-visit] the download failed', origin, error)
      return { kind: 'done', outcome: 'unfinished' }
    }
  }

  const pin = async (bundle: Extract<FirstBundle, { ok: true }>): Promise<BackgroundOutcome> => {
    const installed = await deps.loader.installFetched(bundle.canonicalOrigin, bundle.manifest, bundle.tree, bundle.entries, bundle.declaration, bundle.content)
    if (installed.outcome === 'installed' && installed.servingFailed !== true) return 'pinned'
    await bundle.discard()
    console.log(`[orivon] the download of ${origin} could not be pinned`)
    return 'unfinished'
  }

  /** The answer is yes: what caching staged is pinned, or the download is made now, with the app followed to its next version if it moved. */
  const run = async (): Promise<BackgroundOutcome> => {
    allowed = true
    const early = precache
    precache = undefined
    let step = early === undefined ? await download() : await early
    // Staged before the answer, it must also be the tree that was allowed; and a caching that did not finish is tried again, now free to follow a move.
    if (step.kind === 'whole' && current.declaration !== undefined && judgeBundle(step.bundle.tree, current.declaration).kind === 'block') {
      await step.bundle.discard()
      step = await download()
    } else if (step.kind === 'done' && step.outcome === 'unfinished' && early !== undefined && !cancelled) {
      step = await download()
    }
    if (step.kind === 'done') return step.outcome
    if (ended) {
      await step.bundle.discard()
      return 'blocked'
    }
    return await pin(step.bundle)
  }

  const cache = (): void => {
    precache ??= download().then((step) => { precached = true; return step })
  }

  const cancel = async (): Promise<void> => {
    cancelled = true
    stopped.abort()
    const step = await precache?.catch(() => undefined)
    precache = undefined
    if (step?.kind === 'whole') await step.bundle.discard()
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
        if (held !== undefined && !await consider(held)) throw new Error(`${name}: the person kept the current version, which is no longer served`)
      },
      onServed: () => {}
    },
    enteredTab: (tab) => { entered = tab },
    declared: (declaration) => {
      const held = heldOf(current.read, declaration)
      known.delete(versionKey(current.live))
      current = held
      known.set(versionKey(held.live), held)
    },
    markServed: () => { served = true },
    cache,
    landed: () => precached,
    stopped: () => ended,
    signal: stopped.signal,
    block,
    cancel,
    start
  }
}
