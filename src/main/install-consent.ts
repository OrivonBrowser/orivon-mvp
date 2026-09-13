// The install-time consent mechanism: owner decision d-0025 (ADR-0012's
// 2026-09-13 amendment) -- ask once, before the app's own code runs, for
// the WHOLE set its manifest declares, never one dialog per capability.
// Mirrors request-grant.ts's own split: this file stays free of any
// Electron import (a stub prompt exercises it under plain vitest),
// ./install-consent-prompt.ts owns the real dialog, and app-install.ts
// calls this from installFromHint's own 'installed' branch -- see that
// file's header for exactly where.
//
// "ONCE PER ORIGIN, EVER" (A139) IS DERIVED, NOT TRACKED HERE. registerApp
// (GrantLedger's own `grantsHydrated` flag) already restores every still-
// valid persisted grant into the live ledger, checked against THIS call's
// freshly fetched manifest, before this function ever runs -- see
// app-install.ts's call order. So an origin already accepted on a prior
// visit, this session or a past one, already holds a live grant for its
// declared capabilities by the time this checks, and asking again would be
// exactly the fatigue ADR-0012 exists to prevent. THE ONE CASE THIS DOES
// NOT REMEMBER: a fully DECLINED visit persists no grant at all, so nothing
// on disk distinguishes "asked, said no" from "never asked" -- a declined
// origin is asked again on its next visit. Filed as A145 rather than
// silently accepted; see docs/open-questions.md.

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
 * to ask, skip asking when there is nothing to ask or it was already asked,
 * show the dialog, and grant everything on acceptance.
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
  // A139 bound 2 -- see this file's header. EVERY, not ANY (A155): a second
  // door, app.requestGrant, can hold exactly ONE declared capability before
  // this ever runs (README.md, Design notes) -- `.some` would read that as
  // "already asked" and silently withhold every OTHER declared capability
  // forever. `.every` only skips once nothing declared is left unheld.
  if (capabilities.every((capability) => held.some((existing) => existing.capability === capability))) return

  if (consent === undefined) return // no prompt wired -- fail closed, same stance request-grant.ts takes

  let accepted: boolean
  try {
    accepted = await consent(origin, manifest, capabilities)
  } catch (error) {
    console.error('[install-consent] the consent prompt threw; treating this visit as declined', origin, error)
    return
  }
  if (!accepted) return // A138: all-or-nothing -- the app stays installed, holding nothing

  await grantChangedCapabilities(broker, origin, manifest, capabilities)
}
