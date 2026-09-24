import { describe, expect, it } from 'vitest'
import type { SiteProvenance } from '../../../verifier-host/protocol.js'
import { contentAddressOf } from '../content-address.js'

const CID = 'bafybeiczdb3ssfsyyhhgvxwrkkqndv45umiz6vov46l4hvxukyolejbcgi'

function provenance (pointers: SiteProvenance['pointers']): SiteProvenance {
  return { host: 'site.eth', resolver: 'ens', root: { kind: 'ipfs', cid: CID }, pointers, ddoc: { status: 'met', refusals: [] }, mountedAt: 1 }
}

describe('contentAddressOf', () => {
  it('records the root, what the contenthash named, and the block it was proven at', () => {
    expect(contentAddressOf(provenance([{ step: 'contenthash', name: 'site.eth', pointer: { kind: 'ipfs', cid: CID }, provenance: { via: 'chain', block: 7, offchain: false } }])))
      .toEqual({ cid: CID, via: 'ipfs', block: 7, pointersVerified: true })
  })

  it('records a DNSLink hop as unverified, and a fixture name with no block', () => {
    expect(contentAddressOf(provenance([
      { step: 'contenthash', name: 'site.eth', pointer: { kind: 'dnslink', domain: 'a.example' }, provenance: { via: 'fixture' } },
      { step: 'dnslink', domain: 'a.example', target: `/ipfs/${CID}` }
    ]))).toEqual({ cid: CID, via: 'dnslink', pointersVerified: false })
  })

  it('refuses a site with no contenthash hop', () => {
    expect(() => contentAddressOf(provenance([]))).toThrow(/contenthash/)
  })
})
