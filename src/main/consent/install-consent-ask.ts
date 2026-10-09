// The install question as a first visit asks it (ADR-0074): the asking and the granting are two steps, because
// the app must be served and registered before anything is granted. `askInstallConsent` decides what to ask, shows it and
// reports the answer, touching no grant and recording no refusal; `applyInstallConsent` makes the grants once
// the app is registered. `requestInstallConsent` (./install-consent.ts) is both at once, for an app Orivon already holds.
//
// Only a pressed Deny is a no. Escape, a closed tab, a navigation or a prompt that failed answer `left`: nothing is
// recorded, and the next visit asks again.
import { patternSetFromCapabilities } from '../../broker/policy/manifest-patterns.js'
import type { Broker } from '../../broker/broker-contracts.js'
import type { CapabilityKind, Manifest } from '../../contracts/index.js'
import { grantChangedCapabilities } from './grant-changed-capabilities.js'
import type { InstallConsentPrompt, PerCapabilityConsentPrompt } from './install-consent.js'
import type { DialogCaller } from './request-grant.js'

export type InstallAsk =
  /** Nothing declared, everything held or refused one by one earlier, or no prompt wired. */
  | { readonly outcome: 'not-asked' }
  /** Nobody answered: the tab moved on, the person dismissed the question, or the prompt failed. */
  | { readonly outcome: 'left' }
  /** The person pressed Deny. */
  | { readonly outcome: 'denied' }
  | { readonly outcome: 'accepted', readonly capabilities: readonly CapabilityKind[], readonly refused: readonly CapabilityKind[] }

export async function askInstallConsent (
  broker: Broker,
  consent: InstallConsentPrompt | undefined,
  origin: string,
  manifest: Manifest,
  perCapabilityConsent?: PerCapabilityConsentPrompt,
  caller?: DialogCaller
): Promise<InstallAsk> {
  // Every key was set by patternSetFromCapabilities itself, so this cast trusts nothing untrusted.
  const declared = Object.keys(patternSetFromCapabilities(manifest.capabilities)) as readonly CapabilityKind[]
  if (declared.length === 0) return { outcome: 'not-asked' }
  const held = await broker.app.grants(origin)
  const notHeld = declared.filter((capability) => !held.some((existing) => existing.capability === capability))
  const refusedBefore = await broker.declinedCapabilitiesFor(origin)
  const outstanding = refusedBefore === undefined ? notHeld : notHeld.filter((capability) => !refusedBefore.includes(capability))
  if (outstanding.length === 0) return { outcome: 'not-asked' }

  if (manifest.consentGranularity === 'per-capability' && perCapabilityConsent !== undefined) {
    let chosen: readonly CapabilityKind[] | null
    try {
      chosen = caller === undefined ? await perCapabilityConsent(origin, manifest, outstanding) : await perCapabilityConsent(origin, manifest, outstanding, caller)
    } catch (error) {
      console.error('[install-consent] the per-capability consent prompt threw; nothing decided this visit', origin, error)
      return { outcome: 'left' }
    }
    if (chosen === null || (caller !== undefined && !caller.stillOn(origin))) return { outcome: 'left' }
    // A broken prompt must fail toward asking again, never toward granting something nobody was shown.
    const answered: readonly CapabilityKind[] = chosen
    const accepted = outstanding.filter((capability) => answered.includes(capability))
    if (accepted.length === 0) return { outcome: 'denied' }
    return { outcome: 'accepted', capabilities: accepted, refused: outstanding.filter((capability) => !accepted.includes(capability)) }
  }

  if (consent === undefined) return { outcome: 'not-asked' }
  let answer: boolean | 'dismissed'
  try {
    // The whole declared set, so a person choosing all-or-nothing sees the complete picture.
    answer = caller === undefined
      ? await consent(origin, manifest, declared, held.map((grant) => grant.capability))
      : await consent(origin, manifest, declared, held.map((grant) => grant.capability), caller)
  } catch (error) {
    console.error('[install-consent] the consent prompt threw; nothing decided this visit', origin, error)
    return { outcome: 'left' }
  }
  if (answer === 'dismissed' || (caller !== undefined && !caller.stillOn(origin))) return { outcome: 'left' }
  return answer ? { outcome: 'accepted', capabilities: declared, refused: [] } : { outcome: 'denied' }
}

/** Grants what `ask` accepted, bounded to `manifest`'s own declared patterns, and records what was refused one by one. */
export async function applyInstallConsent (broker: Broker, origin: string, manifest: Manifest, ask: InstallAsk): Promise<void> {
  if (ask.outcome !== 'accepted') return
  // Cleared before granting: grantChangedCapabilities swallows a per-capability failure, and a stale "no" left
  // over a capability that failed to grant would silence the question the person just answered yes to.
  await broker.clearDeclinedConsent(origin)
  if (ask.refused.length > 0) await broker.recordDeclinedConsent(origin, ask.refused)
  await grantChangedCapabilities(broker, origin, manifest, ask.capabilities)
}
