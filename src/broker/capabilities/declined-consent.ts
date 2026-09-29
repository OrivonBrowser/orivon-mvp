// The advisory decline-tracking surface (A145): three entry points
// `../index.ts`'s createBroker returns directly, split out the same way
// ./id.ts is -- this file owns no state of its own, only the three
// functions, over `GrantLedger` and `canonical` taken as constructed
// dependencies.
//
// GENUINELY NEVER-REJECTING, unlike every `canonical()`-guarded method in
// ../index.ts: `main/consent/install-consent.ts` documents itself as never
// throwing, and A145's value is advisory only, so degrading a bad origin to
// "nothing remembered" / "nothing recorded" costs one avoidable re-prompt at
// worst, never a security regression, exactly like every other failure mode
// this feature already tolerates.

import type { GrantLedger } from '../grants/grant-ledger.js'
import type { CapabilityKind } from '../../contracts/index.js'

export interface DeclinedConsentEntryPoints {
  declinedCapabilitiesFor: (origin: string) => Promise<readonly CapabilityKind[] | undefined>
  recordDeclinedConsent: (origin: string, capabilities: readonly CapabilityKind[]) => Promise<void>
  clearDeclinedConsent: (origin: string) => Promise<void>
}

export function createDeclinedConsentEntryPoints (ledger: GrantLedger, canonical: (origin: string) => string): DeclinedConsentEntryPoints {
  async function declinedCapabilitiesFor (origin: string): Promise<readonly CapabilityKind[] | undefined> {
    let key: string
    try {
      key = canonical(origin)
    } catch (error) {
      console.error('[broker] declinedCapabilitiesFor called with a string that is not an origin', origin, error)
      return undefined
    }
    return ledger.declinedCapabilitiesFor(key)
  }

  async function recordDeclinedConsent (origin: string, capabilities: readonly CapabilityKind[]): Promise<void> {
    let key: string
    try {
      key = canonical(origin)
    } catch (error) {
      console.error('[broker] recordDeclinedConsent called with a string that is not an origin', origin, error)
      return
    }
    ledger.recordDeclinedConsent(key, capabilities)
  }

  async function clearDeclinedConsent (origin: string): Promise<void> {
    let key: string
    try {
      key = canonical(origin)
    } catch (error) {
      console.error('[broker] clearDeclinedConsent called with a string that is not an origin', origin, error)
      return
    }
    ledger.clearDeclinedConsent(key)
  }

  return { declinedCapabilitiesFor, recordDeclinedConsent, clearDeclinedConsent }
}
