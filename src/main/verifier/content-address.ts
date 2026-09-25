import type { ContentAddress } from '../../broker/policy/pin.js'
import { pointerChainVerdict } from '../../resolution/pointer-chain.js'
import type { SiteProvenance } from '../../verifier-host/protocol.js'

/** What a pin records of where a `.eth` bundle came from. Throws for a site whose first hop is not a contenthash naming IPFS content. */
export function contentAddressOf (provenance: SiteProvenance): ContentAddress {
  const first = provenance.pointers[0]
  if (first?.step !== 'contenthash' || first.pointer.kind === 'unsupported') throw new Error(`${provenance.host} was not mounted from a contenthash naming IPFS content`)
  const block = first.provenance.via === 'chain' ? first.provenance.block : undefined
  return {
    cid: provenance.root.cid,
    via: first.pointer.kind,
    ...(block === undefined ? {} : { block }),
    pointersVerified: pointerChainVerdict(provenance.pointers).verified
  }
}
