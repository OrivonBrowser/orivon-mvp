// What happens to an installed app whose name moved (ADR-0055). The loader found the new manifest
// (`update-available`); this file judges the offer verified or not, asks the person, and on a yes
// has the loader fetch exactly the offered root, then installs it and reloads the origin's tabs.
// The old version keeps running until then. Electron-free: the questions, the tabs and the score
// provider come in through `AppUpdatesDeps`, the same split ../consent/update-outcomes.ts uses.

import { originFromUrl } from '../../broker/policy/origin.js'
import { compareVersions } from '../../broker/policy/update.js'
import type { LoadResult, LoadUpdateAvailable } from '../../loader/index.js'
import type { QuietOffer, UpdateOfferRecord } from '../../loader/update-offer.js'
import { isQuiet, withQuiet } from '../../loader/update-offer.js'
import { canonicalCid } from '../../protocols/ipfs/names.js'
import { updateTrust } from '../../trust/app-update-trust.js'
import type { UnverifiedReason } from '../../trust/app-update-trust.js'
import { originHost } from '../../trust/domain-binding.js'
import { scoreIdOf } from '../../trust/score-provider.js'
import type { ProviderVerdict } from '../../trust/score-provider.js'
import { describeCapabilityGrant } from '../consent/grant-prompt-render.js'
import type { DialogCaller } from '../consent/request-grant.js'
import { driveLoadResult } from '../consent/update-outcomes.js'
import type { UpdateOutcomeDeps } from '../consent/update-outcomes.js'
import { loadContextFor } from './app-install.js'
import { withOriginQueue } from './origin-queue.js'

/** An update the person has been offered and has not taken. */
export interface UpdateOffer {
  readonly origin: string
  readonly fromCid: string
  readonly toCid: string
  /** The version in use, when its pin is readable. */
  readonly fromVersion: string | undefined
  readonly toVersion: string
  /** The name the new manifest claims for itself: shown as a claim, never as who it is. */
  readonly claimedName: string
  /** The provider's level for this exact version, when it has one. */
  readonly level: number | undefined
  readonly verified: boolean
  readonly reasons: readonly UnverifiedReason[]
  /** The `domain` the new manifest names. */
  readonly newDomain: string | undefined
}

/** `null` is a question nobody answered: the tab left, so the offer is raised again on the next visit. */
export interface UpdatePrompts {
  verified: (offer: UpdateOffer, caller?: DialogCaller) => Promise<{ readonly yes: boolean, readonly quiet: boolean } | null>
  notice: (offer: UpdateOffer, caller?: DialogCaller) => Promise<{ readonly quiet: boolean } | null>
  /** Trust & Force: `held` are the grants that carry over to the new version. */
  confirmForce: (offer: UpdateOffer, held: readonly string[], caller?: DialogCaller) => Promise<boolean>
  failed: (offer: UpdateOffer, reason: string, caller?: DialogCaller) => Promise<void>
}

export interface AppUpdatesDeps {
  /** What installing an applied update goes through: the three questions an update can still raise. `offerUpdate` is this file's own, set by the caller. */
  readonly outcome: UpdateOutcomeDeps
  /** The chosen provider's verdict on a page identifier, asked with no wait. */
  readonly verdictFor: (id: string | undefined) => Promise<ProviderVerdict>
  readonly prompts: UpdatePrompts
  /** Reloads every tab showing `origin`, in any window. */
  readonly reloadTabs: (origin: string) => void
  /** False in a private session: a tick lasts the session and writes nothing. */
  readonly persistQuiet: boolean
}

export type ApplyOutcome = { readonly ok: true } | { readonly ok: false, readonly reason: string }

export interface AppUpdates {
  /**
   * The loader found a moved name: judge it, remember it, and ask unless the person has said not to.
   * Resolves when the question is answered. A Yes takes the origin's queue itself, so a caller that
   * holds it must start this outside it (`outsideOriginQueue`): an unanswered question then never
   * holds the queue, and `apply` from the key's popover is not stuck behind it.
   */
  offered: (result: LoadUpdateAvailable, caller?: DialogCaller) => Promise<void>
  pending: (origin: string) => UpdateOffer | undefined
  /** The name went back to the pinned content: drops the origin's offer. */
  withdraw: (origin: string) => void
  /** Takes the offer for `origin`, which must name exactly `toCid`: verified at once, unverified only after the Trust & Force confirmation. */
  apply: (origin: string, toCid: string, caller?: DialogCaller) => Promise<ApplyOutcome>
  /** Calls back when an origin's pending offer appears, changes or goes; returns the unsubscribe. */
  onChange: (listener: (origin: string) => void) => () => void
}

const cidId = (cid: string): string | undefined => {
  const value = canonicalCid(cid)
  return value === undefined ? undefined : scoreIdOf({ kind: 'cid', value })
}

export function createAppUpdates (deps: AppUpdatesDeps): AppUpdates {
  const { loader, broker } = deps.outcome
  const offers = new Map<string, UpdateOffer>()
  const listeners = new Set<(origin: string) => void>()
  const dismissed = new Set<string>()
  const asking = new Set<string>()
  const sessionQuiet = new Map<string, UpdateOfferRecord>()

  const changed = (origin: string): void => { for (const listener of listeners) listener(origin) }
  const keyOf = (origin: string, cid: string, verified: boolean): string => `${origin} ${cid} ${String(verified)}`

  async function judge (result: LoadUpdateAvailable): Promise<UpdateOffer> {
    const origin = result.canonicalOrigin
    const [pin, floor, verdict] = await Promise.all([loader.pinFor(origin), broker.versionFloorFor(origin), deps.verdictFor(cidId(result.toCid))])
    const pinnedVerdict: ProviderVerdict = pin?.content === undefined ? { status: 'off' } : await deps.verdictFor(cidId(pin.content.cid))
    const trust = updateTrust({
      verdict,
      pinnedVerdict,
      versionOrder: compareVersions(result.manifest.version, floor),
      newDomain: result.manifest.domain,
      originHost: originHost(origin),
      pointersVerified: result.pointersVerified
    })
    return {
      origin,
      fromCid: result.fromCid,
      toCid: result.toCid,
      fromVersion: pin?.version,
      toVersion: result.manifest.version,
      claimedName: result.manifest.name,
      level: verdict.status === 'judged' ? verdict.evaluation.trustlessity.level : undefined,
      verified: trust.verified,
      reasons: trust.verified ? [] : trust.reasons,
      newDomain: result.manifest.domain
    }
  }

  async function quietFor (origin: string, cid: string, verified: boolean): Promise<boolean> {
    const remembered = sessionQuiet.get(origin)
    if (remembered !== undefined && isQuiet(remembered, cid, verified)) return true
    return deps.persistQuiet && isQuiet(await loader.quietOffers(origin), cid, verified)
  }

  async function keepQuiet (origin: string, offer: QuietOffer): Promise<void> {
    sessionQuiet.set(origin, withQuiet(sessionQuiet.get(origin) ?? { quiet: [] }, offer))
    if (deps.persistQuiet) await loader.keepQuiet(origin, offer)
  }

  /** Fetches the offered root, installs it and reloads the origin's tabs. Runs inside the origin's queue. */
  async function applyLocked (offer: UpdateOffer, caller: DialogCaller | undefined): Promise<ApplyOutcome> {
    const { origin } = offer
    if (!offer.verified) {
      const held = (await broker.app.grants(origin)).map((grant) => describeCapabilityGrant(grant.capability, grant.patterns).message)
      if (!await deps.prompts.confirmForce(offer, held, caller)) return { ok: false, reason: 'declined' }
      if (caller !== undefined && !caller.stillOn(origin)) return { ok: false, reason: 'declined' }
    }
    const context = await loadContextFor(broker, origin)
    const result: LoadResult = await loader.applyUpdate(origin, offer.toCid, context)
    // The person has said yes to this very update, so the question about a changed bundle is answered.
    const driven = await driveLoadResult({ ...deps.outcome, reconsentPrompt: async () => true }, result, context, caller)
    if (driven.outcome === 'installed') {
      offers.delete(origin)
      changed(origin)
      deps.reloadTabs(origin)
      return { ok: true }
    }
    if (driven.outcome === 'rejected') {
      if (driven.movedAgain === true) {
        offers.delete(origin)
        changed(origin)
      } else {
        await deps.prompts.failed(offer, driven.reason, caller)
      }
      return { ok: false, reason: driven.reason }
    }
    return { ok: false, reason: 'declined' }
  }

  async function offered (result: LoadUpdateAvailable, caller?: DialogCaller): Promise<void> {
    const offer = await judge(result)
    const { origin } = offer
    offers.set(origin, offer)
    changed(origin)
    const key = keyOf(origin, offer.toCid, offer.verified)
    // One question per offer: a check that finds the same move while it is still open adds nothing.
    if (dismissed.has(key) || asking.has(key) || await quietFor(origin, offer.toCid, offer.verified)) return
    asking.add(key)
    try {
      await ask(offer, caller)
    } finally {
      asking.delete(key)
    }
  }

  async function ask (offer: UpdateOffer, caller: DialogCaller | undefined): Promise<void> {
    const { origin } = offer
    if (offer.verified) {
      const answer = await deps.prompts.verified(offer, caller)
      if (answer === null) return
      if (answer.yes) {
        await takeLocked(origin, offer.toCid, caller)
        return
      }
      dismissed.add(keyOf(origin, offer.toCid, true))
      if (answer.quiet) await keepQuiet(origin, { cid: offer.toCid, verified: true })
      return
    }
    const answer = await deps.prompts.notice(offer, caller)
    if (answer === null) return
    dismissed.add(keyOf(origin, offer.toCid, false))
    if (answer.quiet) await keepQuiet(origin, { cid: offer.toCid, verified: false })
  }

  /** Takes the offer in the origin's queue, but only if it is still the one pending. */
  async function takeLocked (origin: string, toCid: string, caller: DialogCaller | undefined): Promise<ApplyOutcome> {
    return await withOriginQueue(origin, async () => {
      const offer = offers.get(origin)
      if (offer === undefined || offer.toCid !== toCid) return { ok: false, reason: 'no such offer' } as const
      return await applyLocked(offer, caller)
    })
  }

  return {
    offered,
    pending: (origin) => offers.get(origin),
    withdraw: (origin) => {
      if (offers.delete(origin)) changed(origin)
    },
    apply: async (origin, toCid, caller) => {
      if (originFromUrl(origin) !== origin) return { ok: false, reason: 'no such offer' }
      return await takeLocked(origin, toCid, caller)
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
  }
}
