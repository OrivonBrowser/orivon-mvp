import { describe, expect, it } from 'vitest'
import { pointerChainVerdict } from '../pointer-chain.js'
import type { PointerStep } from '../records.js'

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const KEY = 'k51qzi5uqu5dj8'

const onChainIpfs: PointerStep = { step: 'contenthash', name: 'vitalik.eth', pointer: { kind: 'ipfs', cid: CID }, provenance: { via: 'chain', block: 20_000_000, offchain: false } }
const onChainIpns: PointerStep = { step: 'contenthash', name: 'app.ens.eth', pointer: { kind: 'ipns-key', key: KEY }, provenance: { via: 'chain', block: 20_000_000, offchain: true } }
const ipnsRecord: PointerStep = { step: 'ipns-record', key: KEY, sequence: 7n, target: `/ipfs/${CID}` }
const onChainDnslink: PointerStep = { step: 'contenthash', name: 'uniswap.eth', pointer: { kind: 'dnslink', domain: 'app.uniswap.org' }, provenance: { via: 'chain', block: 20_000_000, offchain: false } }
const dnslink: PointerStep = { step: 'dnslink', domain: 'app.uniswap.org', target: `/ipfs/${CID}` }

describe('pointerChainVerdict', () => {
  it('verified for a contenthash proven on chain pointing straight at a CID', () => {
    expect(pointerChainVerdict([onChainIpfs])).toEqual({ verified: true })
  })

  it('verified through a signed IPNS record, offchain resolver or not', () => {
    expect(pointerChainVerdict([onChainIpns, ipnsRecord])).toEqual({ verified: true })
  })

  it('verified for a test fixture name', () => {
    expect(pointerChainVerdict([{ ...onChainIpfs, provenance: { via: 'fixture' } }])).toEqual({ verified: true })
  })

  it('not verified through a DNSLink, naming that hop, even behind a proven contenthash', () => {
    expect(pointerChainVerdict([onChainDnslink, dnslink])).toEqual({ verified: false, unverified: dnslink })
  })

  it('not verified when the contenthash itself came from DNS', () => {
    const fromDns: PointerStep = { ...onChainIpfs, provenance: { via: 'dns', domain: 'example.com' } }
    expect(pointerChainVerdict([fromDns])).toEqual({ verified: false, unverified: fromDns })
  })

  it('names the first unverified hop of several', () => {
    const dnsIpns: PointerStep = { step: 'dnslink', domain: 'a.example', target: `/ipns/${KEY}` }
    expect(pointerChainVerdict([onChainDnslink, dnsIpns, ipnsRecord])).toEqual({ verified: false, unverified: dnsIpns })
  })

  it('an empty chain proves nothing', () => {
    expect(pointerChainVerdict([])).toEqual({ verified: false, unverified: undefined })
  })
})
