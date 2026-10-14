// The install-time consent mechanism (ADR-0012): ask once, before the app's own code runs, about every capability its
// manifest declares and nothing already decided, in one question. This file stays free of any Electron import (a stub
// prompt exercises it under plain vitest); ./install-consent-prompt.ts owns the real question, and ./install-consent-ask.ts
// is the same flow split for a first visit.
//
// "ONCE PER OUTSTANDING CAPABILITY" HAS TWO HALVES, ONE DERIVED AND ONE RECORDED. An accept is derived from the grant
// ledger's own hydration, never tracked as separate state. A refusal is a persisted record (A145,
// GrantLedger.declinedCapabilitiesFor/recordDeclinedConsent): nothing else on disk distinguishes "asked, said no" from
// "never asked". It is advisory only -- it can suppress this question, never grant anything.
// See src/broker/grants/declined-consent.ts and docs/open-questions.md A145.

import { patternSetFromCapabilities } from '../../broker/policy/manifest-patterns.js'
import type { Broker } from '../../broker/broker-contracts.js'
import type { CapabilityKind, Manifest } from '../../contracts/index.js'
import { grantChangedCapabilities } from './grant-changed-capabilities.js'
import type { DialogCaller } from './request-grant.js'

/**
 * The first-visit question: asks about exactly `capabilities` -- already narrowed to what is outstanding (neither held
 * nor declined) -- and resolves the SUBSET the person allowed, which may be all of it, part of it or none. `null` is any
 * way out that is not an answer (Escape, a closed tab, a navigation): nothing is decided and nothing is recorded.
 * `requestInstallConsent` trusts nothing about the answer beyond "some subset of what it was given": it filters the
 * answer back down to `capabilities`, and every grant it leads to is re-bounded by `decideGrantRequest` regardless.
 */
export type InstallConsentPrompt = (
  origin: string,
  manifest: Manifest,
  capabilities: readonly CapabilityKind[],
  caller?: DialogCaller
) => Promise<readonly CapabilityKind[] | null>

/**
 * What the question came to: `granted` (something was allowed), `declined` (the person said no, now
 * or earlier, and holds nothing), `not-asked` (nothing declared, everything held, or no prompt
 * wired) and `left` (nobody answered: the tab moved on or the prompt failed, so nothing is recorded).
 */
export type InstallConsentOutcome = 'granted' | 'declined' | 'not-asked' | 'left'

/**
 * Runs d-0025's whole flow for one freshly-installed origin: work out what is outstanding (declared, neither held nor
 * declined), skip asking when nothing is, show the question, grant what the person allowed and record the rest as
 * declined. A way out of the question counts as a no here, where `askInstallConsent` (./install-consent-ask.ts) leaves
 * it unrecorded.
 *
 * Never throws. A failure anywhere in here -- no prompt wired, the prompt itself rejecting, a grant call rejecting --
 * degrades to "nothing new granted", rather than un-installing an app that already finished installing.
 */
export async function requestInstallConsent (
  broker: Broker,
  consent: InstallConsentPrompt | undefined,
  origin: string,
  manifest: Manifest,
  caller?: DialogCaller
): Promise<InstallConsentOutcome> {
  const declared = patternSetFromCapabilities(manifest.capabilities)
  // Every key here was set by patternSetFromCapabilities itself, so this cast trusts nothing untrusted.
  const capabilities = Object.keys(declared) as readonly CapabilityKind[]
  if (capabilities.length === 0) return 'not-asked' // A139 bound 1: nothing declared, nothing to ask

  const held = await broker.app.grants(origin)
  // A139 bound 2: a second door, app.requestGrant, can hold ONE declared capability before this ever runs
  // (README.md, Design notes); filtering to what is not held keeps that from withholding every other one forever (A157).
  const notHeld = capabilities.filter((capability) => !held.some((existing) => existing.capability === capability))
  if (notHeld.length === 0) return 'not-asked'

  // OUTSTANDING = covered by neither a live grant nor a past decline (A145, A172).
  const declined = await broker.declinedCapabilitiesFor(origin)
  const outstanding = declined === undefined ? notHeld : notHeld.filter((capability) => !declined.includes(capability))
  if (outstanding.length === 0) return held.length > 0 ? 'not-asked' : 'declined'

  if (consent === undefined) return 'not-asked' // no prompt wired -- fail closed, same stance request-grant.ts takes

  let answered: readonly CapabilityKind[] | null
  try {
    answered = caller === undefined ? await consent(origin, manifest, outstanding) : await consent(origin, manifest, outstanding, caller)
  } catch (error) {
    console.error('[install-consent] the consent prompt threw; nothing decided this visit', origin, error)
    return 'left'
  }

  // The page that asked may have navigated away, or closed, while the question was up: nobody who can still see this
  // origin answered it, so nothing is granted and, as important, nothing is recorded as declined.
  if (caller !== undefined && !caller.stillOn(origin)) return 'left'

  // Filtered back down to `outstanding`, so a broken prompt fails toward asking again, never toward granting something nobody was shown.
  const accepted = outstanding.filter((capability) => answered?.includes(capability) === true)
  const refused = outstanding.filter((capability) => !accepted.includes(capability))

  // A capability that silently fails to grant (grantChangedCapabilities swallows a per-capability failure) is never
  // recorded as declined either: it stays outstanding and is asked about again next visit. Nothing outstanding was
  // declined, so there is no stale "no" to clear; an earlier one over a capability not asked about this round stands.
  await recordDeclined(broker, origin, declined, refused)
  if (accepted.length === 0) return 'declined'
  await grantChangedCapabilities(broker, origin, manifest, accepted)
  return 'granted'
}

/**
 * A172: the ONE write the refusals go through. Appends `newlyDeclined` to `declined` -- never a wholesale replace --
 * because a caller only ever passes what was asked about THIS round, so an earlier decline outside it (a capability the
 * manifest no longer declares, say) must survive. Best-effort, never throws (see declined-consent.ts): the worst a lost
 * write costs is one avoidable re-prompt next restart.
 */
async function recordDeclined (
  broker: Broker,
  origin: string,
  declined: readonly CapabilityKind[] | undefined,
  newlyDeclined: readonly CapabilityKind[]
): Promise<void> {
  if (newlyDeclined.length === 0) return
  await broker.recordDeclinedConsent(origin, [...(declined ?? []), ...newlyDeclined])
}
