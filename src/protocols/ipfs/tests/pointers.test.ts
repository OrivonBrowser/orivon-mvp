import { describe, expect, it } from 'vitest'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { createIPNSRecord, createIPNSRecordWithExpiration, marshalIPNSRecord } from 'ipns'
import { CID } from 'multiformats/cid'
import { base36 } from 'multiformats/bases/base36'
import { base58btc } from 'multiformats/bases/base58'
import type { Refusal } from '../../resolution/providers.js'
import { resolveDnslink } from '../dnslink.js'
import { GatewayPool } from '../gateways.js'
import { memorySequenceStore, resolveIpnsKey } from '../ipns.js'
import { canonicalKey, parseContentPath } from '../names.js'
import { followPointer } from '../pointers.js'
import { buildDag, fakeGateways } from './dag.test-helpers.js'

const A = 'https://a.gateway'
const B = 'https://b.gateway'
const dag = await buildDag({ 'index.html': 'x' })
const signal = new AbortController().signal

async function ipnsKey (): Promise<{ key: Awaited<ReturnType<typeof generateKeyPair>>, name: string }> {
  const key = await generateKeyPair('Ed25519')
  return { key, name: CID.createV1(0x72, key.publicKey.toMultihash()).toString(base36) }
}

async function signed (key: Awaited<ReturnType<typeof generateKeyPair>>, value: string, sequence: bigint): Promise<Uint8Array> {
  return marshalIPNSRecord(await createIPNSRecord(key, value, sequence, 60 * 60 * 1000))
}

describe('canonicalKey', () => {
  it('gives one form for a key however it was written', async () => {
    const { key, name } = await ipnsKey()
    const multihash = key.publicKey.toMultihash()
    expect(canonicalKey(name)).toBe(name)
    expect(canonicalKey(CID.createV1(0x72, multihash).toString())).toBe(name)
    expect(canonicalKey(base58btc.baseEncode(multihash.bytes))).toBe(name)
  })

  it('refuses what is not a key', () => {
    expect(canonicalKey('not a key')).toBeUndefined()
  })
})

describe('parseContentPath', () => {
  it('reads /ipfs/, /ipns/ keys and /ipns/ domains', async () => {
    const { name } = await ipnsKey()
    expect(parseContentPath(`/ipfs/${dag.root.toString()}`)).toMatchObject({ kind: 'ipfs' })
    expect(parseContentPath(`/ipns/${name}`)).toEqual({ kind: 'ipns-key', key: name })
    expect(parseContentPath('/ipns/App.Uniswap.org')).toEqual({ kind: 'dnslink', domain: 'app.uniswap.org' })
  })

  it('gives a CIDv0 back as CIDv1', () => {
    const v0 = CID.createV0(dag.root.multihash as Parameters<typeof CID.createV0>[0]).toString()
    const target = parseContentPath(`/ipfs/${v0}`)
    expect(target?.kind === 'ipfs' && target.cid.version === 1 && target.cid.equals(dag.root)).toBe(true)
  })

  it('refuses a path inside the target, another namespace, or garbage', () => {
    for (const value of [`/ipfs/${dag.root.toString()}/sub`, '/ipld/x', '/ipfs/notacid', '/ipns/localhost', 'ipfs/x']) {
      expect(parseContentPath(value)).toBeUndefined()
    }
  })
})

describe('resolveDnslink', () => {
  it('joins split strings, ignores other TXT records, and takes the first value in order', async () => {
    const txt = async (): Promise<string[][]> => [['v=spf1'], ['dnslink=/ipns/', 'b.example'], ['dnslink=/ipfs/a']]
    expect(await resolveDnslink('app.example', txt, signal)).toBe('/ipfs/a')
  })

  it('asks for the _dnslink subdomain', async () => {
    const asked: string[] = []
    await resolveDnslink('app.example', async (name) => { asked.push(name); return [['dnslink=/ipfs/a']] }, signal)
    expect(asked).toEqual(['_dnslink.app.example'])
  })

  it('is not found without a DNSLink, and unavailable when DNS fails', async () => {
    await expect(resolveDnslink('a.example', async () => [['other']], signal)).rejects.toMatchObject({ failure: 'not-found' })
    await expect(resolveDnslink('a.example', async () => { throw new Error('SERVFAIL') }, signal)).rejects.toMatchObject({ failure: 'unavailable' })
  })
})

describe('resolveIpnsKey', () => {
  it('returns a validly signed record and remembers its sequence', async () => {
    const { key, name } = await ipnsKey()
    const gw = fakeGateways(new Map())
    gw.ipns(name, await signed(key, `/ipfs/${dag.root.toString()}`, 5n))
    const sequences = memorySequenceStore()
    const record = await resolveIpnsKey(name, gw.fetch, { pool: new GatewayPool([A, B], 4), nameServices: [] }, sequences, 5000, signal, () => {})
    expect(record).toEqual({ key: name, sequence: 5n, value: `/ipfs/${dag.root.toString()}` })
    expect(sequences.highest(name)).toBe(5n)
  })

  it('refuses a record signed by another key, drops that gateway, and uses the next', async () => {
    const { key, name } = await ipnsKey()
    const { key: forger } = await ipnsKey()
    const gw = fakeGateways(new Map())
    gw.ipns(name, await signed(forger, '/ipfs/bafkqaaa', 9n), [A])
    gw.ipns(name, await signed(key, `/ipfs/${dag.root.toString()}`, 5n), [B])
    const pool = new GatewayPool([A, B], 4)
    const refused: Refusal[] = []
    const record = await resolveIpnsKey(name, gw.fetch, { pool, nameServices: [] }, memorySequenceStore(), 5000, signal, (r) => { refused.push(r) })
    expect(record.sequence).toBe(5n)
    expect(refused).toEqual([{ source: A, resource: `/ipns/${name}` }])
    expect(pool.usable()).toEqual([B])
  })

  it('refuses a rollback to a lower sequence than seen before', async () => {
    const { key, name } = await ipnsKey()
    const gw = fakeGateways(new Map())
    gw.ipns(name, await signed(key, '/ipfs/bafkqaaa', 3n))
    const sequences = memorySequenceStore()
    sequences.record(name, 4n)
    await expect(resolveIpnsKey(name, gw.fetch, { pool: new GatewayPool([A], 4), nameServices: [] }, sequences, 5000, signal, () => {})).rejects.toMatchObject({ failure: 'unverifiable' })
  })

  it('asks a name service after the gateways, when no gateway has the record', async () => {
    const { key, name } = await ipnsKey()
    const record = await signed(key, `/ipfs/${dag.root.toString()}`, 100_001n)
    const gw = fakeGateways(new Map())
    const asked: string[] = []
    const fetch: typeof gw.fetch = async (url, init) => {
      asked.push(url)
      if (url.startsWith('https://names.example/name/')) return new Response(JSON.stringify({ value: `/ipfs/${dag.root.toString()}`, record: Buffer.from(record).toString('base64') }), { headers: { 'content-type': 'application/json' } })
      return await gw.fetch(url, init)
    }
    const found = await resolveIpnsKey(name, fetch, { pool: new GatewayPool([A], 4), nameServices: ['https://names.example'] }, memorySequenceStore(), 5000, signal, () => {})
    expect(found.sequence).toBe(100_001n)
    expect(asked).toEqual([`${A}/ipns/${name}?format=ipns-record`, `https://names.example/name/${name}`])
  })

  it('refuses a forged record from a name service too', async () => {
    const { name } = await ipnsKey()
    const { key: forger } = await ipnsKey()
    const record = await signed(forger, '/ipfs/bafkqaaa', 1n)
    const fetch = async (): Promise<Response> => new Response(JSON.stringify({ record: Buffer.from(record).toString('base64') }))
    const refused: Refusal[] = []
    await expect(resolveIpnsKey(name, fetch, { pool: new GatewayPool([A], 4), nameServices: ['https://names.example'] }, memorySequenceStore(), 5000, signal, (r) => { refused.push(r) })).rejects.toMatchObject({ failure: 'unverifiable' })
    expect(refused.map((r) => r.source)).toContain('https://names.example')
  })

  it('treats an expired record as unavailable, not as a lie', async () => {
    const { key, name } = await ipnsKey()
    const gw = fakeGateways(new Map())
    const expired = await createIPNSRecordWithExpiration(key, '/ipfs/bafkqaaa', 1n, new Date(Date.now() - 60_000).toISOString())
    gw.ipns(name, marshalIPNSRecord(expired))
    const pool = new GatewayPool([A], 4)
    await expect(resolveIpnsKey(name, gw.fetch, { pool, nameServices: [] }, memorySequenceStore(), 5000, signal, () => {})).rejects.toMatchObject({ failure: 'unavailable' })
    expect(pool.usable()).toEqual([A])
  })
})

describe('followPointer', () => {
  const resolvers = (gw: ReturnType<typeof fakeGateways>, txt: Record<string, string> = {}, maxHops = 4): Parameters<typeof followPointer>[1] => ({
    ipns: async (key, s, onRefusal) => await resolveIpnsKey(key, gw.fetch, { pool: new GatewayPool([A], 4), nameServices: [] }, memorySequenceStore(), 5000, s, onRefusal),
    resolveTxt: async (name) => txt[name] === undefined ? [] : [[`dnslink=${txt[name]!}`]],
    maxHops
  })

  it('takes an IPFS contenthash to its root in no hops', async () => {
    const result = await followPointer({ kind: 'ipfs', cid: dag.root.toString() }, resolvers(fakeGateways(new Map())), signal, () => {})
    expect(result.root.equals(dag.root)).toBe(true)
    expect(result.steps).toEqual([])
  })

  it('ends at a CIDv1 root when a DNSLink names a CIDv0', async () => {
    const v0 = CID.createV0(dag.root.multihash as Parameters<typeof CID.createV0>[0]).toString()
    const result = await followPointer({ kind: 'dnslink', domain: 'app.example' }, resolvers(fakeGateways(new Map()), { '_dnslink.app.example': `/ipfs/${v0}` }), signal, () => {})
    expect(result.root.toString()).toBe(dag.root.toString())
  })

  it('follows a DNSLink to an IPNS key to a CID, recording each hop', async () => {
    const { key, name } = await ipnsKey()
    const gw = fakeGateways(new Map())
    gw.ipns(name, await signed(key, `/ipfs/${dag.root.toString()}`, 1n))
    const result = await followPointer({ kind: 'dnslink', domain: 'app.example' }, resolvers(gw, { '_dnslink.app.example': `/ipns/${name}` }), signal, () => {})
    expect(result.root.equals(dag.root)).toBe(true)
    expect(result.steps).toEqual([
      { step: 'dnslink', domain: 'app.example', target: `/ipns/${name}` },
      { step: 'ipns-record', key: name, sequence: 1n, target: `/ipfs/${dag.root.toString()}` }
    ])
  })

  it('stops a chain longer than the hop limit', async () => {
    const txt = { '_dnslink.a.example': '/ipns/b.example', '_dnslink.b.example': '/ipns/a.example' }
    await expect(followPointer({ kind: 'dnslink', domain: 'a.example' }, resolvers(fakeGateways(new Map()), txt, 3), signal, () => {})).rejects.toMatchObject({ failure: 'unverifiable' })
  })

  it('refuses an unsupported contenthash', async () => {
    await expect(followPointer({ kind: 'unsupported', protocol: 'swarm' }, resolvers(fakeGateways(new Map())), signal, () => {})).rejects.toMatchObject({ failure: 'unsupported' })
  })
})
