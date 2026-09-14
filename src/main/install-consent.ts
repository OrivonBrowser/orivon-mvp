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
 * call uses. All-or-nothing: A138 is parked, so there is no per-row answer
 * to return.
 */
export type InstallConsentPrompt = (
  origin: string,
  manifest: Manifest,
  capabilities: readonly CapabilityKind[]
) => Promise<boolean>

/**
 * Runs d-0025's whole flow for one freshly-installed origin: work out what
 * to ask, skip asking when there is nothing to ask or it was already asked
 * (either accepted or declined), show the dialog, and grant everything on
 * acceptance.
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
  manifest: Manifest
): Promise<void> {
  const declared = patternSetFromCapabilities(manifest.capabilities)
  // Same idiom update.ts's widensAuthority uses for a PatternSet's own keys
  // (that file's own comment on why): every key here was set by
  // patternSetFromCapabilities itself, so this cast trusts nothing untrusted.
  const capabilities = Object.keys(declared) as readonly CapabilityKind[]
  if (capabilities.length === 0) return // A139 bound 1: nothing declared, nothing to ask

  const held = await broker.app.grants(origin)
  // A139 bound 2 -- see this file's header. EVERY, not ANY (A157): a second
  // door, app.requestGrant, can hold exactly ONE declared capability before
  // this ever runs (README.md, Design notes) -- `.some` would read that as
  // "already asked" and silently withhold every OTHER declared capability
  // forever. `.every` only skips once nothing declared is left unheld.
  if (capabilities.every((capability) => held.some((existing) => existing.capability === capability))) return

  // A145: the remembered-no check. `declined` is exactly the set this
  // origin's dialog was last DECLINED for -- not a boolean -- so a manifest
  // that now asks for something NOT in that set is a genuinely different
  // question and is asked again. A manifest asking for the same set, or a
  // NARROWER one, is treated as still covered by the earlier "no" (AI
  // recommendation, retunable -- see docs/open-questions.md A145's
  // 2026-09-14 update for the argument and the alternative).
  const declined = await broker.declinedCapabilitiesFor(origin)
  if (declined !== undefined && capabilities.every((capability) => declined.includes(capability))) return

  if (consent === undefined) return // no prompt wired -- fail closed, same stance request-grant.ts takes

  let accepted: boolean
  try {
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
