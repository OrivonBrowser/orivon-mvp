// A file up to MAX_BUFFERED_BYTES is read whole before it is sent (server.ts),
// but its chunks are views into blocks a shared cache already verified. This
// suite checks that buffering many requests for one such file costs the
// budget below, not one fresh copy per request, and that a request past the
// budget is refused rather than piled on.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { request } from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:https'
import type { NameRecord } from '../../../resolution/records.js'
import type { DataGatherer, MountedSite, NameResolver } from '../../../resolution/providers.js'
import { ProtocolRegistry } from '../../../registry.js'
import { defineProtocol } from '../../../protocol.js'
import { ENS } from '../../../ens/descriptor.js'
import { IPFS } from '../../../ipfs/descriptor.js'
import { createIpfsAddressResolvers } from '../../../ipfs/address-resolver.js'
import { createRunCertificate } from '../certificate.js'
import { MAX_BUFFERED_BYTES, createVerifierServer } from '../server.js'
import { Sites } from '../sites.js'

const ROOT = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
// One backing store: every request's chunks are views of it, the way requests
// for the same file actually share the block cache that fetched it.
const SHARED = Buffer.alloc(MAX_BUFFERED_BYTES, 7)

const site: MountedSite = {
  gatherer: 'stub',
  root: { kind: 'ipfs', cid: ROOT },
  pointers: [],
  open: async () => ({
    servedPath: '/big.bin',
    size: SHARED.length,
    body: (async function * () {
      for (let at = 0; at < SHARED.length; at += 256 * 1024) yield SHARED.subarray(at, at + 256 * 1024)
    })()
  }),
  ddoc: () => ({ status: 'met', refusals: [] })
}
const record: NameRecord = { type: 'contenthash', pointer: { kind: 'ipfs', cid: ROOT }, provenance: { via: 'fixture' } }
const resolver: NameResolver = { id: 'stub', namespaces: ['.eth'], resolve: async () => [record] }
const gatherer: DataGatherer = { id: 'stub', supports: () => true, mount: async () => site }
const registry = new ProtocolRegistry([
  defineProtocol(ENS, { resolvers: [resolver], gatherers: [gatherer] }),
  defineProtocol(IPFS, { resolvers: createIpfsAddressResolvers() })
])

let server: Server
let port: number
beforeAll(async () => {
  server = createVerifierServer(registry, new Sites(registry), createRunCertificate())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => { server.closeAllConnections(); server.close() })

async function open (id: string | number, partition?: string, targetPort: number = port): Promise<{ req: ClientRequest, res: IncomingMessage }> {
  return await new Promise((resolve, reject) => {
    const host = `budget${String(id)}.eth`
    const headers: Record<string, string> = { host }
    if (partition !== undefined) headers['x-orivon-partition'] = partition
    const req = request({ host: '127.0.0.1', port: targetPort, path: '/big.bin', servername: host, rejectUnauthorized: false, headers }, (res) => {
      res.pause() // never read: an unread tab leaves the response queued this way too
      resolve({ req, res })
    })
    req.on('error', reject)
    req.end()
  })
}

async function get (path: string, partition?: string, targetPort: number = port): Promise<number> {
  return await new Promise((resolve, reject) => {
    const host = 'budget-sanity.eth'
    const headers: Record<string, string> = { host }
    if (partition !== undefined) headers['x-orivon-partition'] = partition
    const req = request({ host: '127.0.0.1', port: targetPort, path, servername: host, rejectUnauthorized: false, headers }, (res) => {
      res.resume()
      res.on('end', () => { resolve(res.statusCode ?? 0) })
    })
    req.on('error', reject)
    req.end()
  })
}

describe('the loopback server, buffering a file before it sends it', () => {
  it('holds a shared file once, not once per request, and refuses past a total budget', async () => {
    // None of these set a partition header: they all share the one bucket
    // kept for requests with no partition (partitionOf returns undefined).
    const N = 12
    const before = process.memoryUsage().arrayBuffers
    const held = await Promise.all(Array.from({ length: N }, async (_, i) => await open(i)))
    await new Promise((resolve) => setTimeout(resolve, 200))
    const grown = process.memoryUsage().arrayBuffers - before
    // Every accepted request's chunks are views into the one SHARED backing
    // store: holding several of them costs far less than that many full
    // copies of the file would.
    expect(grown).toBeLessThan(3 * MAX_BUFFERED_BYTES)

    const accepted = held.filter(({ res }) => res.statusCode === 200)
    const refused = held.filter(({ res }) => res.statusCode === 503)
    expect(accepted.length).toBeGreaterThan(0)
    expect(accepted.length).toBeLessThan(N)
    expect(accepted.length + refused.length).toBe(N)
    expect(refused[0]?.res.headers['retry-after']).toBe('1')

    for (const { req } of held) req.destroy()
    await new Promise((resolve) => setTimeout(resolve, 200))
    // The budget is released once those responses are gone: a fresh request
    // for the same file is served again, not refused forever.
    expect(await get('/big.bin')).toBe(200)
  }, 60_000)

  it("keeps one partition's own exhaustion from refusing a different partition's request", async () => {
    const A = 'https://a.example'
    const B = 'https://b.example'
    // Fills A's own share (4 requests) and pushes one past it.
    const heldA = await Promise.all(Array.from({ length: 5 }, async (_, i) => await open(`a${String(i)}`, A)))
    const acceptedA = heldA.filter(({ res }) => res.statusCode === 200)
    const refusedA = heldA.filter(({ res }) => res.statusCode === 503)
    expect(acceptedA).toHaveLength(4)
    expect(refusedA).toHaveLength(1)

    // B has spent nothing: A's own exhaustion never reaches it.
    expect(await get('/big.bin', B)).toBe(200)

    for (const { req } of heldA) req.destroy()
  }, 60_000)

  it('refuses past the combined backstop even though no single partition is over its own share', async () => {
    // Five partitions, each filling its own per-partition share (four
    // requests): 5 * 4 * MAX_BUFFERED_BYTES is past the combined backstop,
    // though every partition on its own stayed at exactly its own limit.
    const jobs = Array.from({ length: 5 }, (_, p) => `https://p${String(p)}.example`)
      .flatMap((partition, p) => Array.from({ length: 4 }, (_, i) => ({ partition, id: `p${String(p)}-${String(i)}` })))
    const held = await Promise.all(jobs.map(async (job) => await open(job.id, job.partition)))
    const accepted = held.filter(({ res }) => res.statusCode === 200)
    const refused = held.filter(({ res }) => res.statusCode === 503)
    expect(accepted).toHaveLength(16) // the combined backstop, 16 * MAX_BUFFERED_BYTES
    expect(refused).toHaveLength(4)

    for (const { req } of held) req.destroy()
  }, 60_000)
})

describe('the loopback server, releasing a buffered reservation on a deadline', () => {
  const DEADLINE_MS = 200
  let deadlineServer: Server
  let deadlinePort: number
  beforeAll(async () => {
    deadlineServer = createVerifierServer(registry, new Sites(registry), createRunCertificate(), DEADLINE_MS)
    await new Promise<void>((resolve) => deadlineServer.listen(0, '127.0.0.1', resolve))
    deadlinePort = (deadlineServer.address() as AddressInfo).port
  })
  afterAll(() => { deadlineServer.closeAllConnections(); deadlineServer.close() })

  it('frees an unread reservation once the deadline passes, for a different partition to use', async () => {
    const A = 'https://deadline-a.example'
    const B = 'https://deadline-b.example'
    // Fills A's own per-partition share, and never reads any of it.
    const heldA = await Promise.all(Array.from({ length: 4 }, async (_, i) => await open(`deadline-a${String(i)}`, A, deadlinePort)))
    expect(heldA.every(({ res }) => res.statusCode === 200)).toBe(true)
    // Right away, the reservation is still held: a fifth request from A is refused.
    expect(await get('/big.bin', A, deadlinePort)).toBe(503)

    // Past the deadline, none of A's four responses were ever read, yet a
    // request from a DIFFERENT partition is served: A's reservation is gone,
    // not just A's own retry succeeding some other way.
    await new Promise((resolve) => setTimeout(resolve, DEADLINE_MS + 500))
    expect(await get('/big.bin', B, deadlinePort)).toBe(200)

    for (const { req } of heldA) req.destroy()
  }, 20_000)
})
