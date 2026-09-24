import { describe, expect, it } from 'vitest'
import type { SiteProvenance } from '../../../verifier-host/protocol.js'
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

describe('liveNameEvidence', () => {
  it('says where the name was proven, what it points to, and when it was checked', () => {
    const evidence = liveNameEvidence(provenance({}), NOW)
    expect(evidence.content).toEqual({ source: 'live', cid: CID, ddoc: 'met' })
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

  it('carries a DNSLink as unverified, and a failed file, into the content evidence', () => {
    const viaDns = liveNameEvidence(provenance({
      pointers: [
        { step: 'contenthash', name: 'uni.eth', pointer: { kind: 'dnslink', domain: 'app.example' }, provenance: { via: 'fixture' } },
        { step: 'dnslink', domain: 'app.example', target: `/ipfs/${CID}` }
      ],
      ddoc: { status: 'not-met', reason: 'via DNS: app.example', refusals: [] }
    }), NOW)
    expect(viaDns.content).toEqual({ source: 'live', cid: CID, ddoc: 'not-met', reason: 'via DNS: app.example' })
    expect(viaDns.nameProven).toBe(false)
    expect(viaDns.line).toBe('Name not verified: it points through DNS (app.example)')
    expect(viaDns.rows.map((r) => r.value)).toContain('Via DNS: app.example, which anyone on the network path could forge')
    expect(liveNameEvidence(provenance({ ddoc: { status: 'failed', resource: '/app.js', refusals: [] } }), NOW).content).toMatchObject({ ddoc: 'failed', reason: '/app.js' })
  })
})

describe('pinnedNameEvidence', () => {
  it('says what an installed app came from and how its name was proven', () => {
    expect(pinnedNameEvidence({ cid: CID, via: 'ipfs', block: 7, pointersVerified: true })).toEqual({
      content: { source: 'pinned', cid: CID, pointersVerified: true },
      nameProven: true,
      line: 'Installed from the content its name pointed to. Proven at block 7 when installed',
      rows: [{ term: 'Installed from', value: 'bafybeiczdb3…olejbcgi' }, { term: 'Name', value: 'Proven at block 7 when installed' }]
    })
    expect(pinnedNameEvidence({ cid: CID, via: 'dnslink', pointersVerified: false }).rows[1]?.value).toMatch(/DNSLink/)
    expect(pinnedNameEvidence({ cid: CID, via: 'ipfs', pointersVerified: true }).rows[1]?.value).toMatch(/test fixture/)
  })
})

describe('chooseNameEvidence', () => {
  const pinned = { cid: 'bafkreiapinnedcontentaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', via: 'ipfs' as const, block: 7, pointersVerified: true }

  it('describes the bytes the tab shows: the pin when served from it, else the live mount', () => {
    expect(chooseNameEvidence(pinned, true, provenance({}), 'x', NOW).content).toMatchObject({ source: 'pinned' })
    expect(chooseNameEvidence(pinned, false, provenance({}), 'x', NOW).content).toMatchObject({ source: 'live' })
    expect(chooseNameEvidence(undefined, false, provenance({}), 'x', NOW).content).toMatchObject({ source: 'live' })
    expect(chooseNameEvidence(pinned, false, null, 'x', NOW).content).toMatchObject({ source: 'pinned' })
  })

  it('says why nothing is known when the verifier has no answer and nothing is installed', () => {
    const none = chooseNameEvidence(undefined, false, null, 'Catching up with the chain, since just now.', NOW)
    expect(none).toMatchObject({ content: undefined, nameProven: false, line: 'Name not verified. Catching up with the chain, since just now.' })
  })
})
