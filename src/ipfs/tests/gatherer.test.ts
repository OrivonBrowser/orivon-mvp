import { describe, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import { sha512 } from 'multiformats/hashes/sha2'
import type { NameRecord } from '../../resolution/records.js'
import type { MountedSite } from '../../resolution/providers.js'
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
    expect(g.supports([onChain({ kind: 'unsupported', protocol: 'swarm' })])).toBe(false)
  })

  it('mounts a proven CID, serves its files, and meets DDOC', async () => {
    const site = await gatherer().mount('vitalik.eth', [onChain({ kind: 'ipfs', cid: dag.root.toString() })])
    expect(site.root).toEqual({ kind: 'ipfs', cid: dag.root.toString() })
    expect(site.pointers).toHaveLength(1)
    expect(await read(site, '/')).toBe('<h1>site</h1>')
    expect(site.ddoc()).toEqual({ status: 'met', refusals: [] })
  })

  it('does not meet DDOC through a DNSLink, naming the domain, though every byte is still verified', async () => {
    const txt = { '_dnslink.app.example': `/ipfs/${dag.root.toString()}` }
    const site = await gatherer(undefined, txt).mount('uniswap.eth', [onChain({ kind: 'dnslink', domain: 'app.example' })])
    expect(await read(site, '/app.js')).toBe('run()')
    expect(site.ddoc()).toEqual({ status: 'not-met', reason: 'via DNS: app.example', refusals: [] })
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
