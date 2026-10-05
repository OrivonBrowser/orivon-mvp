// Whether an update an installed app was offered at its name can be called verified (ADR-0055).
// Pure: the caller looks the facts up and hands them over.
//
// Verified means a Web3 Score provider has evaluated exactly the offered content, no lower than
// the content in use, and nothing says the offer is not for this app at this name. It does not
// mean safe: the Security score has no levels yet.

import type { ProviderVerdict } from './score-provider.js'

export interface UpdateTrustFacts {
  /** The chosen provider's verdict on `cid:<the offered root>`, asked with no wait: never pending in practice. */
  readonly verdict: ProviderVerdict
  /** The same for the root the pin holds. */
  readonly pinnedVerdict: ProviderVerdict
  /** `compareVersions(new version, version floor)`: only 1 is an update; the floor passes an equal version. */
  readonly versionOrder: number | null
  /** The `domain` the offered manifest names. */
  readonly newDomain: string | undefined
  readonly originHost: string
  /** Whether every pointer from the name to the offered CID was proven: false through a DNSLink. */
  readonly pointersVerified: boolean
}

export type UnverifiedReason = 'no-provider' | 'no-score' | 'provider-unreachable' | 'lower-level' | 'not-newer' | 'other-home' | 'key-address' | 'unproven-name'

export type UpdateTrust =
  | { readonly verified: true, readonly level: number }
  | { readonly verified: false, readonly reasons: readonly UnverifiedReason[] }

function evaluationReason (verdict: ProviderVerdict): UnverifiedReason | undefined {
  switch (verdict.status) {
    case 'judged': return undefined
    case 'off': return 'no-provider'
    case 'no-score':
    case 'not-assessable': return 'no-score'
    case 'pending':
    case 'unreachable': return 'provider-unreachable'
  }
}

export function updateTrust (facts: UpdateTrustFacts): UpdateTrust {
  const reasons: UnverifiedReason[] = []
  const missing = evaluationReason(facts.verdict)
  if (missing !== undefined) reasons.push(missing)
  if (facts.verdict.status === 'judged' && facts.pinnedVerdict.status === 'judged' && facts.verdict.evaluation.trustlessity.level < facts.pinnedVerdict.evaluation.trustlessity.level) reasons.push('lower-level')
  if (facts.versionOrder !== 1) reasons.push('not-newer')
  // A manifest cannot name a `.orivon` host (src/loader/manifest/domain.ts), so no update at a key can have a bound home.
  if (facts.originHost.endsWith('.orivon')) reasons.push('key-address')
  else if (facts.newDomain !== facts.originHost) reasons.push('other-home')
  if (!facts.pointersVerified) reasons.push('unproven-name')
  if (reasons.length > 0 || facts.verdict.status !== 'judged') return { verified: false, reasons }
  return { verified: true, level: facts.verdict.evaluation.trustlessity.level }
}

/** One reason, in words for the notice and the key's panel. */
export function reasonText (reason: UnverifiedReason, newDomain: string | undefined): string {
  switch (reason) {
    case 'no-provider': return 'No Web3 Score provider is chosen (Settings, Web3), so nothing says who looked at this version.'
    case 'no-score': return 'The Web3 Score provider has no evaluation of this exact version.'
    case 'provider-unreachable': return 'The Web3 Score provider did not answer, so this version could not be checked.'
    case 'lower-level': return 'The provider rates this version lower than the one you are using.'
    case 'not-newer': return 'This version is not newer than the newest one you have installed.'
    case 'other-home': return newDomain === undefined ? 'This version\'s manifest names no home.' : `This version's manifest names ${newDomain} as its home, not this address.`
    case 'key-address': return 'This app is reached at a key, which no manifest can name as its home, so an update here is never verified.'
    case 'unproven-name': return 'The name reached this version through a DNS record, which is not proven.'
  }
}
