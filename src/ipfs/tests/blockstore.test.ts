import { describe, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import { identity } from 'multiformats/hashes/identity'
import { sha512 } from 'multiformats/hashes/sha2'
import * as Digest from 'multiformats/hashes/digest'
import * as dagPb from '@ipld/dag-pb'
import type { Refusal } from '../../resolution/providers.js'
import { BlockCache, BlockSource, blockstoreFor } from '../blockstore.js'
import { GatewayPool } from '../gateways.js'
import { DEFAULT_LIMITS } from '../limits.js'
import type { IpfsLimits } from '../limits.js'
import { buildDag, fakeGateways } from './dag.test-helpers.js'

const A = 'https://a.gateway'
const B = 'https://b.gateway'

const dag = await buildDag({ 'index.html': '<h1>hello</h1>', 'app.js': 'console.log(1)' })
const [leafKey, leafBytes] = [...dag.blocks].find(([key]) => CID.parse(key).code === 0x55)!
const leaf = CID.parse(leafKey)

function source (gateways = fakeGateways(dag.blocks), limits: Partial<IpfsLimits> = {}, order = [A, B]): { source: BlockSource, gateways: ReturnType<typeof fakeGateways>, pool: GatewayPool } {
  const pool = new GatewayPool(order, 4)
  return { source: new BlockSource(gateways.fetch, pool, { ...DEFAULT_LIMITS, ...limits }), gateways, pool }
}

function refusals (): { list: Refusal[], add: (r: Refusal) => void } {
  const list: Refusal[] = []
  return { list, add: (r) => { list.push(r) } }
}

const signal = new AbortController().signal

describe('BlockSource.get', () => {
  it('returns a block that hashes to its CID, from the first gateway', async () => {
    const { source: s, gateways } = source()
    expect(await s.get(leaf, signal, () => {})).toEqual(leafBytes)
    expect(gateways.requests).toEqual([`${A}/ipfs/${leafKey}?format=raw`])
  })

  it('refuses a tampered block, records the refusal, drops that gateway, and uses the next', async () => {
    const { source: s, gateways, pool } = source()
    gateways.tamper(leafKey, [A])
    const r = refusals()
    expect(await s.get(leaf, signal, r.add)).toEqual(leafBytes)
    expect(r.list).toEqual([{ source: A, resource: leafKey }])
    expect(pool.usable()).toEqual([B])
  })

  it('is unverifiable, never a success, when every gateway sends bad bytes', async () => {
    const { source: s, gateways } = source()
    gateways.tamper(leafKey)
    await expect(s.get(leaf, signal, () => {})).rejects.toMatchObject({ failure: 'unverifiable' })
  })

  it('stays unverifiable once every gateway has been dropped for lying', async () => {
    const { source: s, gateways } = source()
    gateways.tamper(leafKey)
    await expect(s.get(leaf, signal, () => {})).rejects.toMatchObject({ failure: 'unverifiable' })
    const other = CID.parse([...dag.blocks.keys()].find((k) => k !== leafKey)!)
    await expect(s.get(other, signal, () => {})).rejects.toMatchObject({ failure: 'unverifiable', message: expect.stringMatching(/dropped/) })
  })

  it('is unavailable when no gateway answers, and nothing is dropped', async () => {
    const { source: s, gateways, pool } = source()
    gateways.failing.add(A)
    gateways.failing.add(B)
    await expect(s.get(leaf, signal, () => {})).rejects.toMatchObject({ failure: 'unavailable' })
    expect(pool.usable()).toEqual([A, B])
  })

  it('falls through a gateway that is down without counting it as a lie', async () => {
    const { source: s, gateways, pool } = source()
    gateways.failing.add(A)
    const r = refusals()
    expect(await s.get(leaf, signal, r.add)).toEqual(leafBytes)
    expect(r.list).toEqual([])
    expect(pool.usable()).toEqual([A, B])
  })

  it('stops reading a body larger than a block may be', async () => {
    const { source: s, gateways } = source(undefined, { maxBlockBytes: 1024 })
    gateways.oversize(leafKey, 4096)
    await expect(s.get(leaf, signal, () => {})).rejects.toMatchObject({ failure: 'unavailable' })
  })

  it('refuses a hash function other than sha2-256 before asking anyone', async () => {
    const { source: s, gateways } = source()
    const cid = CID.createV1(0x55, await sha512.digest(new Uint8Array([1])))
    await expect(s.get(cid, signal, () => {})).rejects.toMatchObject({ failure: 'unsupported' })
    expect(gateways.requests).toEqual([])
  })

  it('refuses a truncated sha2-256 digest before asking anyone, so no honest gateway is blamed', async () => {
    const { source: s, gateways, pool } = source()
    const cid = CID.createV1(0x55, Digest.create(0x12, leaf.multihash.digest.subarray(0, 20)))
    await expect(s.get(cid, signal, () => {})).rejects.toMatchObject({ failure: 'unsupported' })
    expect(gateways.requests).toEqual([])
    expect(pool.usable()).toEqual([A, B])
  })

  it('refuses a codec other than dag-pb or raw before asking anyone', async () => {
    const { source: s, gateways } = source()
    const cid = CID.createV1(0x71, leaf.multihash)
    await expect(s.get(cid, signal, () => {})).rejects.toMatchObject({ failure: 'unsupported' })
    expect(gateways.requests).toEqual([])
  })

  it('serves an identity CID from the CID itself', async () => {
    const { source: s, gateways } = source()
    const bytes = new TextEncoder().encode('inline')
    expect(await s.get(CID.createV1(0x55, identity.digest(bytes)), signal, () => {})).toEqual(bytes)
    expect(gateways.requests).toEqual([])
  })

  it('refuses a genuine node with more links than the limit, without blaming the gateway', async () => {
    const links = Array.from({ length: 3 }, (_, i) => ({ Hash: leaf, Name: `f${String(i)}`, Tsize: 1 }))
    const bytes = dagPb.encode({ Links: links })
    const { sha256 } = await import('multiformats/hashes/sha2')
    const cid = CID.createV1(0x70, await sha256.digest(bytes))
    const { source: s, pool } = source(fakeGateways(new Map([[cid.toString(), bytes]])), { maxLinksPerNode: 2 })
    await expect(s.get(cid, signal, () => {})).rejects.toMatchObject({ failure: 'unverifiable' })
    expect(pool.usable()).toEqual([A, B])
  })

  it('asks the network once for a block it has already verified', async () => {
    const { source: s, gateways } = source()
    await s.get(leaf, signal, () => {})
    await s.get(leaf, signal, () => {})
    expect(gateways.requests).toHaveLength(1)
  })
})

describe('blockstoreFor', () => {
  it('answers a block from the cache only within the partition that fetched it', async () => {
    const gateways = fakeGateways(dag.blocks)
    const pool = new GatewayPool([A, B], 4)
    const cache = new BlockCache()
    const one = new BlockSource(gateways.fetch, pool, DEFAULT_LIMITS, cache, 'https://one.example')
    const two = new BlockSource(gateways.fetch, pool, DEFAULT_LIMITS, cache, 'https://two.example')
    await one.get(leaf, signal, () => {})
    await one.get(leaf, signal, () => {})
    expect(gateways.requests).toHaveLength(1)
    await two.get(leaf, signal, () => {})
    expect(gateways.requests).toHaveLength(2)
  })

  it('counts every block against the open, cached or not', async () => {
    const { source: s } = source(undefined, { maxBlocksPerOpen: 2 })
    const store = blockstoreFor(s, { blocks: 0, bytes: 0 }, signal, () => {})
    for (let i = 0; i < 2; i++) for await (const _ of store.get(leaf)) { void _ }
    await expect(async () => { for await (const _ of store.get(leaf)) { void _ } }).rejects.toMatchObject({ failure: 'unverifiable' })
  })

  it('counts bytes against the open', async () => {
    const { source: s } = source(undefined, { maxBytesPerOpen: leafBytes.length })
    const store = blockstoreFor(s, { blocks: 0, bytes: 0 }, signal, () => {})
    for await (const _ of store.get(leaf)) { void _ }
    await expect(async () => { for await (const _ of store.get(leaf)) { void _ } }).rejects.toMatchObject({ failure: 'unverifiable' })
  })
})
