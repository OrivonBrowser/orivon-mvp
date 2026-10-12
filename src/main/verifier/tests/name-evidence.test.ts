import { describe, expect, it } from 'vitest'
import type { SiteProvenance } from '../../../protocols/verifier-host/protocol.js'
import { chooseNameEvidence, liveNameEvidence, pinnedNameEvidence } from '../name-evidence.js'

const CID = 'bafybeiczdb3ssfsyyhhgvxwrkkqndv45umiz6vov46l4hvxukyolejbcgi'
const KEY = 'k51qzi5uqu5dipklqpo2uq7advlajxx5wxob0mwyqbxb5zu4htblc4bjipy834'
const NOW = 1_790_000_000_000

function provenance (overrides: Partial<SiteProvenance>): SiteProvenance {
  return {
    host: 'site.eth',
    resolver: 'ens',
    root: { kind: 'ipfs', cid: CID },
    pointers: [{ step: 'contenthash', name: 'site.eth', pointer: { kind: 'ipfs', cid: CID }, provenance: { via: 'chain', block: 26_047_527, offchain: false } }],
    ddoc: { status: 'met', refusals: [] },
    mountedAt: NOW - 3 * 60_000,
    ...overrides
  }
}

describe('liveNameEvidence, where the bytes came from', () => {
  const loadedFrom = (overrides: Partial<SiteProvenance>): string | undefined => liveNameEvidence(provenance(overrides), NOW).rows.find((row) => row.term === 'Loaded from')?.value

  it('names the node when the node served the content', () => {
    expect(loadedFrom({ servedFrom: { kind: 'node' } })).toBe("Orivon's IPFS node, on this computer")
  })

  it('names the gateways, and why the node was not used when it was chosen', () => {
    expect(loadedFrom({ servedFrom: { kind: 'gateways' } })).toBe('Public IPFS gateways')
    expect(loadedFrom({ servedFrom: { kind: 'gateways', reason: 'a proxy is configured' } })).toBe('Public IPFS gateways, because a proxy is configured')
  })

  it('says nothing for a protocol that has one kind of source', () => {
    expect(loadedFrom({})).toBeUndefined()
  })

  it('names the node, not its loopback address, when it sent what failed its check', () => {
    const refused = liveNameEvidence(provenance({ ddoc: { status: 'met', refusals: [{ source: 'http://127.0.0.1:20123', resource: 'bafy' }] } }), NOW)
    expect(refused.rows.find((row) => row.term === 'Refused')?.value).toBe("1 response(s) from Orivon's IPFS node failed their check and were not used")
  })
})

describe('liveNameEvidence', () => {
  it('says where the name was proven, what it points to, and when it was checked', () => {
    const evidence = liveNameEvidence(provenance({}), NOW)
    expect(evidence.content).toEqual({ source: 'live', cid: CID, pointersVerified: true })
    expect(evidence.nameProven).toBe(true)
    expect(evidence.line).toBe('Name verified by the light client at block 26,047,527, 3 minutes ago')
    expect(evidence.rows).toEqual([
      { term: 'Name', value: 'Proven by the light client at block 26,047,527' },
      { term: 'Content', value: 'bafybeiczdb3…olejbcgi' },
      { term: 'Checked', value: '3 minutes ago' }
    ])
  })

  it('names an offchain resolver, a signed IPNS record, and refused responses', () => {
    const evidence = liveNameEvidence(provenance({
      pointers: [
        { step: 'contenthash', name: 'app.ens.eth', pointer: { kind: 'ipns-key', key: KEY }, provenance: { via: 'chain', block: 1, offchain: true } },
        { step: 'ipns-record', key: KEY, sequence: 100_001n, target: `/ipfs/${CID}` }
      ],
      ddoc: { status: 'met', refusals: [{ source: 'https://a.gateway', resource: CID }, { source: 'https://a.gateway', resource: KEY }] }
    }), NOW)
    expect(evidence.rows.map((r) => r.value)).toEqual(expect.arrayContaining([
      'Proven by the light client at block 1, through an offchain resolver the contract checked',
      'Signed by its key k51qzi5uqu5d…bjipy834, sequence 100001',
      '2 response(s) from https://a.gateway failed their check and were not used'
    ]))
  })

  it('names a signed Swarm feed update and calls a bzz:// address verified by what it names', () => {
    const feed = liveNameEvidence(provenance({
      root: { kind: 'swarm', cid: CID },
      pointers: [
        { step: 'contenthash', name: 'swarm.eth', pointer: { kind: 'swarm', cid: CID }, provenance: { via: 'chain', block: 5, offchain: false } },
        { step: 'swarm-feed', owner: 'f77a13dc2f786b4523f5e0bf6db6757f4cf60ebb', topic: 'ab'.repeat(32), index: 91n, target: CID }
      ]
    }), NOW)
    expect(feed.nameProven).toBe(true)
    expect(feed.rows.map((r) => r.value)).toContain('Update 91, signed by its owner f77a13dc2f78…4cf60ebb')
    const byAddress = liveNameEvidence(provenance({
      root: { kind: 'swarm', cid: CID },
      pointers: [{ step: 'contenthash', name: CID, pointer: { kind: 'swarm', cid: CID }, provenance: { via: 'address' } }]
    }), NOW)
    expect(byAddress.line).toBe("Address verified: it is the content's own hash, 3 minutes ago")
    expect(byAddress.rows[0]).toEqual({ term: 'Address', value: "The address is the content's own hash" })
  })

  it('does not call a feed-backed bzz:// address the content\'s own hash', () => {
    const evidence = liveNameEvidence(provenance({
      root: { kind: 'swarm', cid: CID },
      pointers: [
        { step: 'contenthash', name: CID, pointer: { kind: 'swarm', cid: CID }, provenance: { via: 'address' } },
        { step: 'swarm-feed', owner: 'f77a13dc2f786b4523f5e0bf6db6757f4cf60ebb', topic: 'ab'.repeat(32), index: 3n, target: CID }
      ]
    }), NOW)
    expect(evidence.line).toBe('Address verified: it names a feed whose signed update was checked, 3 minutes ago')
    expect(evidence.rows[0]).toEqual({ term: 'Address', value: 'The address names a Swarm feed; the content is whatever its newest signed update names' })
  })

  it('carries a DNSLink as unverified, and a failed file, into the content evidence', () => {
    const viaDns = liveNameEvidence(provenance({
      pointers: [
        { step: 'contenthash', name: 'uni.eth', pointer: { kind: 'dnslink', domain: 'app.example' }, provenance: { via: 'fixture' } },
        { step: 'dnslink', domain: 'app.example', target: `/ipfs/${CID}` }
      ],
      ddoc: { status: 'met', refusals: [] }
    }), NOW)
    expect(viaDns.content).toEqual({ source: 'live', cid: CID, pointersVerified: false })
    expect(viaDns.nameProven).toBe(false)
    expect(viaDns.line).toBe('Name not verified: it points through DNS (app.example)')
    expect(viaDns.rows.map((r) => r.value)).toContain('Via DNS: app.example, which anyone on the network path could forge')
    expect(liveNameEvidence(provenance({ ddoc: { status: 'failed', resource: '/app.js', refusals: [] } }), NOW).content).toMatchObject({ failedResource: '/app.js' })
  })

  it('calls an ipfs:// or ipns:// address verified by what it names, with no light client involved', () => {
    const byCid = liveNameEvidence(provenance({
      host: `${CID}.ipfs.orivon`,
      pointers: [{ step: 'contenthash', name: CID, pointer: { kind: 'ipfs', cid: CID }, provenance: { via: 'address' } }]
    }), NOW)
    expect(byCid.nameProven).toBe(true)
    expect(byCid.line).toBe("Address verified: it is the content's own hash, 3 minutes ago")
    expect(byCid.rows[0]).toEqual({ term: 'Address', value: "The address is the content's own hash" })
    const byKey = liveNameEvidence(provenance({
      pointers: [
        { step: 'contenthash', name: KEY, pointer: { kind: 'ipns-key', key: KEY }, provenance: { via: 'address' } },
        { step: 'ipns-record', key: KEY, sequence: 3n, target: `/ipfs/${CID}` }
      ]
    }), NOW)
    expect(byKey.nameProven).toBe(true)
    expect(byKey.line).toBe('Address verified: it names a key whose signed record was checked, 3 minutes ago')
    expect(byKey.rows[0]).toEqual({ term: 'Address', value: 'The address is a key; the content is whatever its signed record names' })
    const byDnslink = liveNameEvidence(provenance({
      pointers: [
        { step: 'contenthash', name: 'docs.ipfs.tech', pointer: { kind: 'dnslink', domain: 'docs.ipfs.tech' }, provenance: { via: 'address' } },
        { step: 'dnslink', domain: 'docs.ipfs.tech', target: `/ipfs/${CID}` }
      ]
    }), NOW)
    expect(byDnslink.nameProven).toBe(false)
    expect(byDnslink.line).toBe('Address not verified: it points through DNS (docs.ipfs.tech)')
    expect(byDnslink.rows[0]).toEqual({ term: 'Address', value: 'The address is a DNS name, followed through DNSLink' })
  })
})

describe('pinnedNameEvidence', () => {
  it('says what an installed app came from and how its name was proven', () => {
    expect(pinnedNameEvidence({ cid: CID, via: 'ipfs', block: 7, pointersVerified: true }, false)).toEqual({
      content: { source: 'pinned', cid: CID, pointersVerified: true },
      nameProven: true,
      line: 'Installed from the content its name pointed to. Proven at block 7 when installed',
      rows: [{ term: 'Installed from', value: 'bafybeiczdb3…olejbcgi' }, { term: 'Name', value: 'Proven at block 7 when installed' }]
    })
    expect(pinnedNameEvidence({ cid: CID, via: 'dnslink', pointersVerified: false }, false).rows[1]?.value).toMatch(/DNSLink/)
    expect(pinnedNameEvidence({ cid: CID, via: 'ipfs', pointersVerified: true }, false).rows[1]?.value).toMatch(/test fixture/)
  })

  it('says an app installed from an address needed no proof of a name, and is no test fixture', () => {
    const evidence = pinnedNameEvidence({ cid: CID, via: 'ipfs', pointersVerified: true }, true)
    expect(evidence.line).toBe("Installed from the content its address pointed to. The address is the content's own hash")
    expect(evidence.rows[1]).toEqual({ term: 'Address', value: "The address is the content's own hash" })
    expect(pinnedNameEvidence({ cid: CID, via: 'ipns-key', pointersVerified: true }, true).rows[1]?.value).toBe('A key whose signed record named the content when installed')
    expect(pinnedNameEvidence({ cid: CID, via: 'dnslink', pointersVerified: false }, true).rows[1]?.value).toMatch(/DNSLink/)
  })
})

describe('chooseNameEvidence', () => {
  const pinned = { cid: 'bafkreiapinnedcontentaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', via: 'ipfs' as const, block: 7, pointersVerified: true }

  it('describes the bytes the tab shows: the pin when served from it, else the live mount', () => {
    expect(chooseNameEvidence(pinned, true, provenance({}), 'x', NOW, false).content).toMatchObject({ source: 'pinned' })
    expect(chooseNameEvidence(pinned, false, provenance({}), 'x', NOW, false).content).toMatchObject({ source: 'live' })
    expect(chooseNameEvidence(undefined, false, provenance({}), 'x', NOW, false).content).toMatchObject({ source: 'live' })
    expect(chooseNameEvidence(pinned, false, null, 'x', NOW, false).content).toMatchObject({ source: 'pinned' })
  })

  it('says why nothing is known when the verifier has no answer and nothing is installed', () => {
    const none = chooseNameEvidence(undefined, false, null, 'Catching up with the chain, since just now.', NOW, false)
    expect(none).toMatchObject({ content: undefined, nameProven: false, line: 'Name not verified. Catching up with the chain, since just now.' })
    expect(chooseNameEvidence(undefined, false, null, 'Not loaded yet.', NOW, true).line).toBe('Address not verified. Not loaded yet.')
  })
})
