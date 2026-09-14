// The install-time consent mechanism: owner decision d-0025 (ADR-0012's
// 2026-09-13 amendment) -- ask once, before the app's own code runs, for
// the WHOLE set its manifest declares, never one dialog per capability.
// Mirrors request-grant.ts's own split: this file stays free of any
// Electron import (a stub prompt exercises it under plain vitest),
// ./install-consent-prompt.ts owns the real dialog, and app-install.ts
// calls this from installFromHint's own 'installed' branch -- see that
// file's header for exactly where.
//
// "ONCE PER ORIGIN, EVER" HAS TWO HALVES, ONE DERIVED AND ONE RECORDED. An
// ACCEPT is derived from the grant ledger's own hydration (registerApp's
// grantsHydrated), never tracked as separate state -- see this function's
// own doc. A DECLINE is a real persisted record (A145,
// GrantLedger.declinedCapabilitiesFor/recordDeclinedConsent): nothing else
// on disk distinguishes "asked, said no" from "never asked". It is
// ADVISORY ONLY -- it can suppress this dialog, never grant anything -- and
// is cleared the moment a later visit accepts, so an old "no" cannot
// outlive a "yes" for the same-or-narrower question. See
// src/broker/grants/declined-consent.ts and docs/open-questions.md A145.
//
// A138's 'per-capability' PATH (docs/open-questions.md), added here: OUTSTANDING
// (neither held nor declined) generalises "once, ever" per capability rather
// than per whole-manifest decision, since a person may now accept part of a
// request and refuse the rest in the same sitting -- see runPerCapabilityConsent.

import { patternSetFromCapabilities } from '../broker/policy/manifest-patterns.js'
import type { Broker } from '../broker/broker-contracts.js'
import type { CapabilityKind, Manifest } from '../contracts/index.js'
import { grantChangedCapabilities } from './grant-changed-capabilities.js'

/**
 * Asks a person, ONCE, whether `origin` may hold everything `capabilities`
 * names -- ALREADY the manifest's own full declared set (`requestInstallConsent`
 * below builds it via `patternSetFromCapabilities`, never a per-capability
 * subset) -- one dialog for the whole install, unlike the per-capability
 * `ConsentPrompt` (`./request-grant.ts`) a live `orivon.app.requestGrant`
 * call uses. All-or-nothing: the answer is a single boolean covering
 * everything at once -- see `PerCapabilityConsentPrompt` below for the
 * per-row answer A138's `'per-capability'` manifest value asks for.
 */
export type InstallConsentPrompt = (
  origin: string,
  manifest: Manifest,
  capabilities: readonly CapabilityKind[]
) => Promise<boolean>

/**
 * A138's 'per-capability' path: asks about exactly `capabilities` -- already
 * narrowed to what is OUTSTANDING (requestInstallConsent below never calls
 * this with something already held or declined, unlike `InstallConsentPrompt`
 * above, which always sees the manifest's full declared set) -- and resolves
 * the SUBSET actually accepted, never a boolean, since the whole point is
 * that some may be accepted and others refused in the same sitting. The
 * real implementation (createPerCapabilityConsentPrompt,
 * ./install-consent-prompt.ts) is free to ask however it likes;
 * requestInstallConsent trusts nothing about the shape of the answer beyond
 * "some subset of what it was given" -- runPerCapabilityConsent below is
 * where that is actually enforced, defensively, even though every grant it
 * leads to is independently re-bounded by decideGrantRequest regardless.
 */
export type PerCapabilityConsentPrompt = (
  origin: string,
  manifest: Manifest,
  capabilities: readonly CapabilityKind[]
) => Promise<readonly CapabilityKind[]>

/**
 * Runs d-0025's whole flow for one freshly-installed origin: work out what
 * to ask, skip asking when there is nothing to ask or it was already asked
 * (either accepted or declined), show the dialog, and grant everything on
 * acceptance. `perCapabilityConsent` is used instead of `consent` only when
 * the manifest declares `consentGranularity: 'per-capability'` AND it is
 * wired -- otherwise this behaves exactly as it did before A138's
 * 'per-capability' path existed, `consentGranularity` absent or
 * 'all-or-nothing' included.
 *
 * Never throws. A failure anywhere in here -- no prompt wired, the prompt
 * itself rejecting, a grant call rejecting -- degrades to "nothing new
 * granted", the same outcome A138's own decline path produces, rather than
 * un-installing an app that already finished installing.
 */
export async function requestInstallConsent (
  broker: Broker,
  consent: InstallConsentPrompt | undefined,
  origin: string,
  manifest: Manifest,
  perCapabilityConsent?: PerCapabilityConsentPrompt
): Promise<void> {
  const declared = patternSetFromCapabilities(manifest.capabilities)
  // Same idiom update.ts's widensAuthority uses for a PatternSet's own keys
  // (that file's own comment on why): every key here was set by
  // patternSetFromCapabilities itself, so this cast trusts nothing untrusted.
  const capabilities = Object.keys(declared) as readonly CapabilityKind[]
  if (capabilities.length === 0) return // A139 bound 1: nothing declared, nothing to ask

  const held = await broker.app.grants(origin)
  // A139 bound 2 -- see this file's header. A second door, app.requestGrant,
  // can hold exactly ONE declared capability before this ever runs
  // (README.md, Design notes) -- filtering to what is NOT held is what stops
  // that from silently withholding every OTHER declared capability forever
  // (A157). No call is skipped entirely unless NOTHING declared is left
  // unheld, matching the old `.every` gate's own short-circuit exactly.
  const notHeld = capabilities.filter((capability) => !held.some((existing) => existing.capability === capability))
  if (notHeld.length === 0) return

  // A145's remembered-no check, generalised into OUTSTANDING = covered by
  // NEITHER a live grant NOR a past decline. Under all-or-nothing a decline
  // always covers the WHOLE declared set at once (the decline branch below
  // still records `capabilities`, never a subset), so this reduces to
  // exactly the old two separate whole-set checks it replaced; under
  // per-capability a decline can cover only SOME capabilities, and this is
  // what stops that mixed state from being silently re-asked in full every
  // restart (see runPerCapabilityConsent's own tests).
  const declined = await broker.declinedCapabilitiesFor(origin)
  const outstanding = declined === undefined ? notHeld : notHeld.filter((capability) => !declined.includes(capability))
  if (outstanding.length === 0) return

  if (manifest.consentGranularity === 'per-capability' && perCapabilityConsent !== undefined) {
    await runPerCapabilityConsent(broker, perCapabilityConsent, origin, manifest, outstanding, declined)
    return
  }

  if (consent === undefined) return // no prompt wired -- fail closed, same stance request-grant.ts takes

  let accepted: boolean
  try {
    // The WHOLE declared set, not `outstanding` -- a person choosing
    // all-or-nothing must see the complete picture even when part of it is
    // already held (A157's own test): grantChangedCapabilities below skips
    // re-granting anything unchanged, so nothing is torn down needlessly.
    accepted = await consent(origin, manifest, capabilities)
  } catch (error) {
    console.error('[install-consent] the consent prompt threw; treating this visit as declined', origin, error)
    return
  }
  if (!accepted) {
    // Remember the no (A145) -- best-effort, never throws (see
    // declined-consent.ts): the worst a lost write costs is one avoidable
    // re-prompt next restart, never a security regression.
    await broker.recordDeclinedConsent(origin, capabilities)
    return // A138: all-or-nothing -- the app stays installed, holding nothing
  }

  // The person just said yes to exactly `capabilities` -- any earlier "no"
  // for this origin is stale the moment this line runs, whatever it covered.
  // CLEARED BEFORE GRANTING, DELIBERATELY: grantChangedCapabilities grants
  // per capability and swallows a per-capability failure (its own doc), so a
  // crash or a partial failure here could leave some capabilities granted
  // and others not. Clearing first means that partial state is read next
  // time as "some held, none declined" -- the existing "already held" check
  // above asks again for whatever is still missing. Clearing AFTER would
  // instead leave the stale decline in place over exactly those still-
  // missing capabilities, silently re-suppressing a dialog the person just
  // said yes to.
  await broker.clearDeclinedConsent(origin)
  await grantChangedCapabilities(broker, origin, manifest, capabilities)
}

/**
 * A138's 'per-capability' path. `outstanding` is already narrowed to what
 * is neither held nor declined -- the ONLY thing this asks about, so a
 * person is never re-asked about a capability they already decided in an
 * earlier visit, however the manifest reorders its own declaration.
 *
 * NEVER TRUSTS THE PROMPT'S OWN ANSWER AS A BOUND ON ITS OWN: `acceptedRaw`
 * is filtered back down to `outstanding` before anything downstream sees
 * it, so a prompt implementation that returned something it was never asked
 * about -- a bug in the prompt, not something this function assumes cannot
 * happen -- can never widen what gets granted. `grantChangedCapabilities`
 * (and, inside it, `decideGrantRequest`) is still the real, independent
 * bound against the manifest; this filter exists one layer up, so a broken
 * PROMPT fails toward "asks again next time," never toward "grants
 * something nobody was shown."
 *
 * A refusal is never a decline of anything OUTSIDE this round: the new
 * declined record is the OLD one plus exactly the newly refused
 * capabilities -- never a wholesale replace -- because nothing accepted or
 * refused just now was ever a member of the old declined set (`outstanding`
 * excludes it by construction), so there is nothing stale to remove.
 */
async function runPerCapabilityConsent (
  broker: Broker,
  perCapabilityConsent: PerCapabilityConsentPrompt,
  origin: string,
  manifest: Manifest,
  outstanding: readonly CapabilityKind[],
  declined: readonly CapabilityKind[] | undefined
): Promise<void> {
  let acceptedRaw: readonly CapabilityKind[]
  try {
    acceptedRaw = await perCapabilityConsent(origin, manifest, outstanding)
  } catch (error) {
    console.error('[install-consent] the per-capability consent prompt threw; nothing decided this visit', origin, error)
    return
  }
  const accepted = outstanding.filter((capability) => acceptedRaw.includes(capability))
  const refused = outstanding.filter((capability) => !accepted.includes(capability))

  // A capability that silently fails to grant (grantChangedCapabilities
  // swallows a per-capability failure, same as the all-or-nothing branch
  // above) is never recorded as declined either -- it stays outstanding and
  // is asked about again next visit, rather than being misfiled as a real
  // "no" nobody actually chose.
  if (refused.length > 0) await broker.recordDeclinedConsent(origin, [...(declined ?? []), ...refused])
  if (accepted.length > 0) await grantChangedCapabilities(broker, origin, manifest, accepted)
}
