import { describe, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import { sha512 } from 'multiformats/hashes/sha2'
import type { NameRecord } from '../../resolution/records.js'
import type { MountedSite } from '../../resolution/providers.js'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { createIPNSRecord, marshalIPNSRecord } from 'ipns'
import { base36 } from 'multiformats/bases/base36'
import { createIpfsGatherer } from '../gatherer.js'
import { memorySequenceStore } from '../ipns.js'
import { buildDag, fakeGateways } from './dag.test-helpers.js'

const A = 'https://a.gateway'
const B = 'https://b.gateway'
const dag = await buildDag({ 'index.html': '<h1>site</h1>', 'app.js': 'run()' })

function gatherer (gw = fakeGateways(dag.blocks), txt: Record<string, string> = {}): ReturnType<typeof createIpfsGatherer> {
  return createIpfsGatherer({
    fetch: gw.fetch,
    gateways: [A, B],
    resolveTxt: async (name) => txt[name] === undefined ? [] : [[`dnslink=${txt[name]!}`]],
    ipnsSequences: memorySequenceStore()
  })
}

const onChain = (pointer: NameRecord['pointer']): NameRecord => ({ type: 'contenthash', pointer, provenance: { via: 'chain', block: 7, offchain: false } })

async function read (site: MountedSite, path: string): Promise<string> {
  const file = await site.open(path)
  let text = ''
  for await (const chunk of file.body) text += new TextDecoder().decode(chunk)
  return text
}

describe('the IPFS gatherer', () => {
  it('supports IPFS, IPNS and DNSLink records, and nothing else', () => {
    const g = gatherer()
    expect(g.supports([onChain({ kind: 'ipfs', cid: dag.root.toString() })])).toBe(true)
    expect(g.supports([onChain({ kind: 'dnslink', domain: 'a.example' })])).toBe(true)
    expect(g.supports([onChain({ kind: 'unsupported', protocol: 'arweave' })])).toBe(false)
  })

  it('mounts a proven CID, serves its files, and meets DDOC', async () => {
    const site = await gatherer().mount('vitalik.eth', [onChain({ kind: 'ipfs', cid: dag.root.toString() })])
    expect(site.root).toEqual({ kind: 'ipfs', cid: dag.root.toString() })
    expect(site.pointers).toHaveLength(1)
    expect(await read(site, '/')).toBe('<h1>site</h1>')
    expect(site.ddoc()).toEqual({ status: 'met', refusals: [] })
  })

  it('serves a root that is one HTML file at /, typed as HTML', async () => {
    const single = await buildDag({ page: '<!doctype html><title>x</title>' }, { wrapWithDirectory: false })
    expect(single.root.code).toBe(0x55)
    const site = await gatherer(fakeGateways(single.blocks)).mount('one.eth', [onChain({ kind: 'ipfs', cid: single.root.toString() })])
    const file = await site.open('/')
    expect(file).toMatchObject({ servedPath: '/', contentType: 'text/html; charset=utf-8' })
    expect(await read(site, '/')).toBe('<!doctype html><title>x</title>')
    expect(site.ddoc()).toEqual({ status: 'met', refusals: [] })
  })

  it('meets DDOC through a DNSLink too, every byte verified, and records the DNS hop among its pointers', async () => {
    const txt = { '_dnslink.app.example': `/ipfs/${dag.root.toString()}` }
    const site = await gatherer(undefined, txt).mount('uniswap.eth', [onChain({ kind: 'dnslink', domain: 'app.example' })])
    expect(await read(site, '/app.js')).toBe('run()')
    expect(site.ddoc()).toEqual({ status: 'met', refusals: [] })
    expect(site.pointers.at(-1)).toMatchObject({ step: 'dnslink', domain: 'app.example' })
  })

  it('still meets DDOC when a gateway lied and another served verified bytes, and names the refusal', async () => {
    const gw = fakeGateways(dag.blocks)
    for (const key of dag.blocks.keys()) gw.tamper(key, [A])
    const site = await gatherer(gw).mount('vitalik.eth', [onChain({ kind: 'ipfs', cid: dag.root.toString() })])
    expect(await read(site, '/')).toBe('<h1>site</h1>')
    const report = site.ddoc()
    expect(report.status).toBe('met')
    expect(report.refusals.length).toBeGreaterThan(0)
    expect(report.refusals.every((r) => r.source === A)).toBe(true)
  })

  it('fails DDOC, naming the resource, when no source served it verified', async () => {
    const gw = fakeGateways(dag.blocks)
    const site = await gatherer(gw).mount('vitalik.eth', [onChain({ kind: 'ipfs', cid: dag.root.toString() })])
    await read(site, '/')
    for (const key of dag.blocks.keys()) gw.tamper(key)
    await expect(read(site, '/app.js')).rejects.toMatchObject({ failure: 'unverifiable' })
    expect(site.ddoc()).toMatchObject({ status: 'failed', resource: '/app.js' })
  })

  it('does not fail DDOC for a missing path or a gateway that is down', async () => {
    const gw = fakeGateways(dag.blocks)
    const site = await gatherer(gw).mount('vitalik.eth', [onChain({ kind: 'ipfs', cid: dag.root.toString() })])
    await expect(read(site, '/missing')).rejects.toMatchObject({ failure: 'not-found' })
    gw.failing.add(A)
    gw.failing.add(B)
    await expect(read(site, '/app.js')).rejects.toMatchObject({ failure: 'unavailable' })
    expect(site.ddoc().status).toBe('met')
  })

  it('refuses a root CID this build cannot verify', async () => {
    const sha512Root = CID.createV1(0x70, await sha512.digest(new Uint8Array([1]))).toString()
    await expect(gatherer().mount('x.eth', [onChain({ kind: 'ipfs', cid: sha512Root })])).rejects.toMatchObject({ failure: 'unsupported', message: expect.stringMatching(/sha2-256/) })
  })
})

describe('the IPFS gatherer over a node on this computer', () => {
  const NODE = 'http://127.0.0.1:20123'

  it('says its mounts came from the node, and says gateways for the usual pool', async () => {
    const gw = fakeGateways(dag.blocks)
    const records = [onChain({ kind: 'ipfs', cid: dag.root.toString() })]
    const viaNode = createIpfsGatherer({ fetch: gw.fetch, gateways: [NODE], resolveTxt: async () => [], ipnsSequences: memorySequenceStore(), localNode: true })
    expect((await viaNode.mount('a.eth', records)).servedFrom).toEqual({ kind: 'node' })
    expect((await gatherer(gw).mount('a.eth', records)).servedFrom).toEqual({ kind: 'gateways' })
  })

  it('asks the node once, and reports it unavailable at once, when the node answers 504 for content it could not find', async () => {
    const gw = fakeGateways(dag.blocks)
    gw.failNext(NODE, 504, 10)
    const viaNode = createIpfsGatherer({ fetch: gw.fetch, gateways: [NODE], resolveTxt: async () => [], ipnsSequences: memorySequenceStore(), localNode: true })
    const site = await viaNode.mount('a.eth', [onChain({ kind: 'ipfs', cid: dag.root.toString() })])
    await expect(read(site, '/')).rejects.toMatchObject({ failure: 'unavailable', message: expect.stringContaining('answered 504') as string })
    expect(gw.requests).toHaveLength(1)
  })

  it('fails a read as unverifiable, and DDOC with it, when the node sends a block that fails its hash', async () => {
    const gw = fakeGateways(dag.blocks)
    const [key] = [...dag.blocks].find(([k]) => CID.parse(k).code === 0x55)!
    gw.tamper(key, [NODE])
    const viaNode = createIpfsGatherer({ fetch: gw.fetch, gateways: [NODE], resolveTxt: async () => [], ipnsSequences: memorySequenceStore(), localNode: true })
    const site = await viaNode.mount('a.eth', [onChain({ kind: 'ipfs', cid: dag.root.toString() })])
    await expect(read(site, '/')).rejects.toMatchObject({ failure: 'unverifiable' })
    expect(site.ddoc()).toMatchObject({ status: 'failed' })
  })
})

describe('the IPFS gatherer over a node that keeps what it fetched, one store for every site', () => {
  const NODE = 'http://127.0.0.1:20123'
  const NAMES = 'https://names.example'
  const HEADER = 'x-orivon-partition'
  const storeKey = { header: HEADER, key: (partition: string) => `key-of-${partition}` }

  /** The requests that reached each source, with the partition header each carried. */
  function recorded () {
    const gw = fakeGateways(dag.blocks)
    const asked: Array<{ url: string, header: string | undefined }> = []
    const fetch: typeof gw.fetch = async (url, init) => {
      asked.push({ url, header: init.headers[HEADER] })
      return await gw.fetch(url, init)
    }
    return { gw, asked, fetch }
  }

  const make = (fetch: ReturnType<typeof fakeGateways>['fetch'], extra: Partial<Parameters<typeof createIpfsGatherer>[0]> = {}) =>
    createIpfsGatherer({ fetch, gateways: [NODE], resolveTxt: async () => [], ipnsSequences: memorySequenceStore(), localNode: true, storeKey, ...extra })
  const records = [onChain({ kind: 'ipfs', cid: dag.root.toString() })]

  it('sends the key of the mount\'s partition with every read from the node', async () => {
    const { asked, fetch } = recorded()
    const site = await make(fetch).mount('a.eth', records, undefined, 'https://a.eth')
    await read(site, '/')
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((request) => request.header === 'key-of-https://a.eth')).toBe(true)
  })

  it('sends another partition\'s reads under another key, and a mount with no partition none at all', async () => {
    const { asked, fetch } = recorded()
    const gatherer = make(fetch)
    await read(await gatherer.mount('a.eth', records, undefined, 'https://one.eth'), '/')
    await read(await gatherer.mount('a.eth', records, undefined, 'https://two.eth'), '/')
    await read(await gatherer.mount('a.eth', records), '/')
    const headers = new Set(asked.map((request) => request.header))
    expect(headers).toEqual(new Set(['key-of-https://one.eth', 'key-of-https://two.eth', undefined]))
  })

  it('asks the node again for what another partition already fetched, since a partition shares nothing with another', async () => {
    const { asked, fetch } = recorded()
    const gatherer = make(fetch)
    await read(await gatherer.mount('a.eth', records, undefined, 'https://one.eth'), '/')
    const first = asked.length
    await read(await gatherer.mount('a.eth', records, undefined, 'https://two.eth'), '/')
    expect(asked.length).toBe(first * 2)
  })

  it('sends the key to the node and to no other source: a name service never sees it', async () => {
    const key = await generateKeyPair('Ed25519')
    const name = CID.createV1(0x72, key.publicKey.toMultihash()).toString(base36)
    const record = marshalIPNSRecord(await createIPNSRecord(key, `/ipfs/${dag.root.toString()}`, 5n, 60 * 60 * 1000))
    const { asked, gw } = recorded()
    const fetch: typeof gw.fetch = async (url, init) => {
      asked.push({ url, header: init.headers[HEADER] })
      if (url.startsWith(`${NAMES}/name/`)) return new Response(JSON.stringify({ record: Buffer.from(record).toString('base64') }))
      return new Response('not found', { status: 404 })
    }
    const gatherer = make(fetch, { ipnsNameServices: [NAMES] })
    await gatherer.mount('k.eth', [onChain({ kind: 'ipns-key', key: name })], undefined, 'https://k.eth')
    const toNode = asked.filter((request) => request.url.startsWith(NODE))
    const toNames = asked.filter((request) => request.url.startsWith(NAMES))
    expect(toNode.length).toBeGreaterThan(0)
    expect(toNode.every((request) => request.header === 'key-of-https://k.eth')).toBe(true)
    expect(toNames).toHaveLength(1)
    expect(toNames[0]?.header).toBeUndefined()
  })

  it('asks a name service only while the list says so, read at each lookup', async () => {
    const key = await generateKeyPair('Ed25519')
    const name = CID.createV1(0x72, key.publicKey.toMultihash()).toString(base36)
    const record = marshalIPNSRecord(await createIPNSRecord(key, `/ipfs/${dag.root.toString()}`, 5n, 60 * 60 * 1000))
    let allowed = false
    const asked: string[] = []
    const fetch = async (url: string): Promise<Response> => {
      asked.push(url)
      if (url.startsWith(`${NAMES}/name/`)) return new Response(JSON.stringify({ record: Buffer.from(record).toString('base64') }))
      return new Response('not found', { status: 404 })
    }
    const gatherer = make(fetch as never, { ipnsNameServices: () => allowed ? [NAMES] : [] })
    const keyRecord = [onChain({ kind: 'ipns-key', key: name })]
    await expect(gatherer.mount('k.eth', keyRecord, undefined, 'https://k.eth')).rejects.toMatchObject({ failure: 'unavailable' })
    expect(asked.some((url) => url.startsWith(NAMES))).toBe(false)
    allowed = true
    await gatherer.mount('k.eth', keyRecord, undefined, 'https://k.eth')
    expect(asked.some((url) => url.startsWith(NAMES))).toBe(true)
  })
})
