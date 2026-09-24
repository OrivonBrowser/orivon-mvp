import type { PointerStep, Provenance } from './records.js'

export type PointerChainVerdict =
  | { readonly verified: true }
  /** The first hop that could not be verified, for the evidence to name. */
  | { readonly verified: false, readonly unverified: PointerStep | undefined }

function provenVia (provenance: Provenance): boolean {
  return provenance.via === 'chain' || provenance.via === 'fixture'
}

function stepVerified (step: PointerStep): boolean {
  switch (step.step) {
    case 'contenthash': return provenVia(step.provenance)
    case 'ipns-record': return true
    // A TXT record anyone on the DNS path can forge; the bytes are still
    // checked against the CID it names, which is why this is not a failure.
    case 'dnslink': return false
  }
}

/**
 * Whether every hop from the name to the content's root was verified: DDOC's
 * pointer half, for a live page and for an installed app's stored chain
 * alike. An empty chain proves nothing.
 */
export function pointerChainVerdict (steps: readonly PointerStep[]): PointerChainVerdict {
  if (steps.length === 0) return { verified: false, unverified: undefined }
  const unverified = steps.find((step) => !stepVerified(step))
  return unverified === undefined ? { verified: true } : { verified: false, unverified }
}
