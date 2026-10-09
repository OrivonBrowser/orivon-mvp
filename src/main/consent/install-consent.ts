// The install-time consent mechanism: d-0025 (ADR-0012) -- ask once,
// before the app's own code runs, for
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

import { patternSetFromCapabilities } from '../../broker/policy/manifest-patterns.js'
import type { Broker } from '../../broker/broker-contracts.js'
import type { CapabilityKind, Manifest } from '../../contracts/index.js'
import { grantChangedCapabilities } from './grant-changed-capabilities.js'
import type { DialogCaller } from './request-grant.js'

/**
 * Asks a person, ONCE, whether `origin` may hold everything `capabilities`
 * names -- ALREADY the manifest's own full declared set (`requestInstallConsent`
 * below builds it via `patternSetFromCapabilities`, never a per-capability
 * subset) -- one dialog for the whole install, unlike the per-capability
 * `ConsentPrompt` (`./request-grant.ts`) a live `orivon.app.requestGrant`
 * call uses. All-or-nothing: the answer is a single boolean covering
 * everything at once -- see `PerCapabilityConsentPrompt` below for the
 * per-row answer A138's `'per-capability'` manifest value asks for.
 *
 * `true` is the person's Allow and `false` their pressing Deny. `'dismissed'` is any way out
 * that is neither (Escape, a closed tab, a navigation): the first-visit order reads it as "ask
 * again next visit" and records nothing, where `requestInstallConsent` below treats it as a no.
 *
 * `held` (A170) is the SUBSET of `capabilities` already granted through
 * that other door -- Deny still applies only to the rest, so the real
 * dialog (./install-consent-prompt.ts) marks those rows rather than
 * letting them read as part of what a Deny actually covers.
 */
export type InstallConsentPrompt = (
  origin: string,
  manifest: Manifest,
  capabilities: readonly CapabilityKind[],
  held: readonly CapabilityKind[],
  caller?: DialogCaller
) => Promise<boolean | 'dismissed'>

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
 * Runs d-0025's whole flow for one freshly-installed origin: work out what
 * to ask, skip asking when there is nothing to ask or it was already asked
 * (either accepted or declined), show the dialog, and grant everything on
 * acceptance. `perCapabilityConsent` is used instead of `consent` only when
 * the manifest declares `consentGranularity: 'per-capability'` AND it is
 * wired -- otherwise this falls back to the all-or-nothing flow below,
 * whether `consentGranularity` is absent or set to 'all-or-nothing'.
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
  perCapabilityConsent?: PerCapabilityConsentPrompt,
  caller?: DialogCaller
): Promise<InstallConsentOutcome> {
  const declared = patternSetFromCapabilities(manifest.capabilities)
  // Same idiom update.ts's widensAuthority uses for a PatternSet's own keys
  // (that file's own comment on why): every key here was set by
  // patternSetFromCapabilities itself, so this cast trusts nothing untrusted.
  const capabilities = Object.keys(declared) as readonly CapabilityKind[]
  if (capabilities.length === 0) return 'not-asked' // A139 bound 1: nothing declared, nothing to ask

  const held = await broker.app.grants(origin)
  // A139 bound 2 -- see this file's header. A second door, app.requestGrant,
  // can hold exactly ONE declared capability before this ever runs
  // (README.md, Design notes) -- filtering to what is NOT held is what stops
  // that from silently withholding every OTHER declared capability forever
  // (A157). No call is skipped entirely unless NOTHING declared is left
  // unheld -- the same short-circuit an `.every` check across `capabilities`
  // would give, applied per key.
  const notHeld = capabilities.filter((capability) => !held.some((existing) => existing.capability === capability))
  if (notHeld.length === 0) return 'not-asked'

  // A145's remembered-no check, generalised into OUTSTANDING = covered by
  // NEITHER a live grant NOR a past decline. A decline, in EITHER
  // granularity, now records only what was actually outstanding this round
  // (A172) -- never something already held or already declined -- so a
  // `'per-capability'` accept-some-refuse-some decision (`held =
  // [tcp.connect]`, `declined = [fs]`, both non-empty, non-overlapping
  // subsets of the same request) is exactly the mixed state this filter
  // exists to stop from being silently re-asked in full every restart (see
  // runPerCapabilityConsent's own tests).
  const declined = await broker.declinedCapabilitiesFor(origin)
  const outstanding = declined === undefined ? notHeld : notHeld.filter((capability) => !declined.includes(capability))
  if (outstanding.length === 0) return held.length > 0 ? 'not-asked' : 'declined'

  if (manifest.consentGranularity === 'per-capability' && perCapabilityConsent !== undefined) {
    return await runPerCapabilityConsent(broker, perCapabilityConsent, origin, manifest, outstanding, declined, caller)
  }

  if (consent === undefined) return 'not-asked' // no prompt wired -- fail closed, same stance request-grant.ts takes

  let accepted: boolean
  try {
    // The WHOLE declared set, not `outstanding` -- a person choosing
    // all-or-nothing must see the complete picture even when part of it is
    // already held (A157's own test): grantChangedCapabilities below skips
    // re-granting anything unchanged, so nothing is torn down needlessly.
    // The held SUBSET of it goes along too (A170), so the real dialog can
    // mark those rows -- Deny below only ever covers `outstanding`, never
    // a row already held through the other door.
    accepted = (caller === undefined
      ? await consent(origin, manifest, capabilities, held.map((grant) => grant.capability))
      : await consent(origin, manifest, capabilities, held.map((grant) => grant.capability), caller)) === true
  } catch (error) {
    console.error('[install-consent] the consent prompt threw; treating this visit as declined', origin, error)
    return 'left'
  }

  // The page that asked may have navigated away, or closed, before the
  // dialog ever showed or at any point while it was up -- whatever
  // `accepted` says, nobody who can still see this origin actually answered
  // it. Neither branch below runs: nothing is granted, and -- just as
  // important -- nothing is recorded as declined, since a person who was
  // never actually asked has not said no. A later, genuine visit still
  // prompts in full.
  if (caller !== undefined && !caller.stillOn(origin)) return 'left'

  if (!accepted) {
    // A172(1): record `outstanding`, never the whole `capabilities` --
    // this dialog showed the complete picture, but only outstanding rows
    // were actually being asked about; a held row Deny does not touch must
    // never be written down as declined (that survived a revoke of the
    // held capability could then never be asked about again, since a
    // declined entry needs no live grant to suppress a future dialog).
    // A172(2): APPENDED to the existing record via the same helper
    // runPerCapabilityConsent's own refusal branch uses below, never a
    // wholesale replace -- an earlier decline outside this round (a
    // different manifest shape, or a granularity switch) must survive it.
    await recordDeclined(broker, origin, declined, outstanding)
    return 'declined' // A138: all-or-nothing -- the app stays installed, holding nothing
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
  return 'granted'
}

/**
 * A172: the ONE write both decline branches below go through, so "declined"
 * cannot mean something different depending on which one ran. Appends
 * `newlyDeclined` to `declined` -- never a wholesale replace -- because a
 * caller only ever passes what was actually asked about THIS round
 * (`outstanding`, or a `'per-capability'` refusal already narrowed to it),
 * so nothing here was ever a member of the old declined set already; there
 * is nothing stale to remove, and the old set's own entries (a decline the
 * current manifest does not even declare any more, say) must survive.
 */
async function recordDeclined (
  broker: Broker,
  origin: string,
  declined: readonly CapabilityKind[] | undefined,
  newlyDeclined: readonly CapabilityKind[]
): Promise<void> {
  if (newlyDeclined.length === 0) return
  // Best-effort, never throws (see declined-consent.ts): the worst a lost
  // write costs is one avoidable re-prompt next restart, never a security
  // regression.
  await broker.recordDeclinedConsent(origin, [...(declined ?? []), ...newlyDeclined])
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
 * A refusal is never a decline of anything OUTSIDE this round -- see
 * `recordDeclined`'s own doc for how that is now true of the all-or-nothing
 * branch above too (A172), through the same write.
 */
async function runPerCapabilityConsent (
  broker: Broker,
  perCapabilityConsent: PerCapabilityConsentPrompt,
  origin: string,
  manifest: Manifest,
  outstanding: readonly CapabilityKind[],
  declined: readonly CapabilityKind[] | undefined,
  caller?: DialogCaller
): Promise<InstallConsentOutcome> {
  let acceptedRaw: readonly CapabilityKind[]
  try {
    acceptedRaw = (caller === undefined
      ? await perCapabilityConsent(origin, manifest, outstanding)
      : await perCapabilityConsent(origin, manifest, outstanding, caller)) ?? []
  } catch (error) {
    console.error('[install-consent] the per-capability consent prompt threw; nothing decided this visit', origin, error)
    return 'left'
  }

  // The page that asked may have navigated away, or closed, during this
  // staged sequence of dialogs -- whatever `acceptedRaw` says, skip both
  // recording and granting: a person who is not there to answer has not
  // declined anything, and a later, genuine visit still asks in full.
  if (caller !== undefined && !caller.stillOn(origin)) return 'left'

  const accepted = outstanding.filter((capability) => acceptedRaw.includes(capability))
  const refused = outstanding.filter((capability) => !accepted.includes(capability))

  // A capability that silently fails to grant (grantChangedCapabilities
  // swallows a per-capability failure, same as the all-or-nothing branch
  // above) is never recorded as declined either -- it stays outstanding and
  // is asked about again next visit, rather than being misfiled as a real
  // "no" nobody actually chose.
  await recordDeclined(broker, origin, declined, refused)
  if (accepted.length > 0) await grantChangedCapabilities(broker, origin, manifest, accepted)
  return accepted.length > 0 ? 'granted' : 'declined'
}
