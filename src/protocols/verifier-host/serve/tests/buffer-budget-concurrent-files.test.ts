// Several large files of one app, each asked for with the leaf it must hash to, all at once: together they are more
// than one partition's share of the buffer budget, so every one of them must still be sent. A file larger than an app
// may carry is answered as a mismatch without being read, and no way out of a request leaves its read in the line.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { request } from 'node:https'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:https'
import type { NameRecord } from '../../../resolution/records.js'
import { ResolutionError } from '../../../resolution/records.js'
import type { DataGatherer, GatheredFile, MountedSite, NameResolver } from '../../../resolution/providers.js'
import { ProtocolRegistry } from '../../../registry.js'
import { defineProtocol } from '../../../protocol.js'
import { ENS } from '../../../ens/descriptor.js'
import { IPFS } from '../../../ipfs/descriptor.js'
import { createIpfsAddressResolvers } from '../../../ipfs/address-resolver.js'
import { MAX_ASSET_BYTES } from '../../../../broker/policy/bundle-hash.js'
import { DDOC_MISMATCH, EXPECT_LEAF_HEADER, FAILURE_HEADER } from '../../../../loader/fetch/content-root.js'
import { leafOf } from '../../../../loader/leaf-hash.js'
import { createRunCertificate } from '../certificate.js'
import { createVerifierServer } from '../server.js'
import { RoutedSites, Sites } from '../sites.js'

const ROOT = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const FILE_BYTES = 24 * 1024 * 1024
const CHUNK_BYTES = 256 * 1024
const PARTS = ['/part-0.js', '/part-1.js', '/part-2.js', '/part-3.js']
const HUGE = '/huge.js'
const SMALL = '/small.js'
const BROKEN = '/broken.js'
const STALLED = '/stalled.js'
const SMALL_BYTES = Buffer.from('run()')
// One backing store, so four files cost the test one file's memory: a file's chunks are views of it.
const SHARED = Buffer.alloc(FILE_BYTES, 7)

// Every body of a round waits until all of its files are opened, then yields a chunk per turn of the event loop: the
// reads advance together, chunk by chunk, however the connections happened to be set up.
let opened = 0
let allOpened: () => void = () => undefined
let everyFileOpened = Promise.resolve()
function startRound (): void {
  opened = 0
  everyFileOpened = new Promise<void>((resolve) => { allOpened = resolve })
}

let hugeBodyRead = false
let stalledReading: () => void = () => undefined
let stalledEnded: () => void = () => undefined
const stalledIsReading = new Promise<void>((resolve) => { stalledReading = resolve })
const stalledHasEnded = new Promise<void>((resolve) => { stalledEnded = resolve })

function openFile (path: string, signal: AbortSignal | undefined): GatheredFile {
  if (path === HUGE) {
    return { servedPath: path, size: MAX_ASSET_BYTES + 1, body: (async function * () { hugeBodyRead = true; yield SHARED.subarray(0, CHUNK_BYTES) })() }
  }
  if (path === SMALL) return { servedPath: path, size: SMALL_BYTES.length, body: (async function * () { yield SMALL_BYTES })() }
  if (path === BROKEN) {
    return { servedPath: path, size: FILE_BYTES, body: (async function * () { yield SHARED.subarray(0, CHUNK_BYTES); throw new ResolutionError('unverifiable', 'block does not hash to its CID') })() }
  }
  if (path === STALLED) {
    // One chunk, then nothing until the client of the request is gone.
    return {
      servedPath: path,
      size: FILE_BYTES,
      body: (async function * () {
        try {
          yield SHARED.subarray(0, CHUNK_BYTES)
          stalledReading()
          await new Promise<void>((resolve) => { signal?.addEventListener('abort', () => { resolve() }, { once: true }) })
          throw new Error('the client went away')
        } finally {
          stalledEnded()
        }
      })()
    }
  }
  if (!PARTS.includes(path)) throw new ResolutionError('not-found', `${path} is not in this site`)
  opened += 1
  if (opened === PARTS.length) allOpened()
  const round = everyFileOpened
  return {
    servedPath: path,
    size: FILE_BYTES,
    body: (async function * () {
      await round
      for (let at = 0; at < FILE_BYTES; at += CHUNK_BYTES) {
        yield SHARED.subarray(at, at + CHUNK_BYTES)
        await new Promise((resolve) => setImmediate(resolve))
      }
    })()
  }
}

const site: MountedSite = {
  gatherer: 'stub',
  root: { kind: 'ipfs', cid: ROOT },
  pointers: [],
  open: async (path, _range, signal) => openFile(path, signal),
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
  server = createVerifierServer(registry, new RoutedSites(new Sites(registry), () => new Sites(registry)), createRunCertificate())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => { server.closeAllConnections(); server.close() })

interface Reply { status: number, bytes: number, failure: string | string[] | undefined }

/** The whole of a file asked for with the leaf it must hash to, read as fast as it is sent. */
async function getChecked (path: string, leaf: string): Promise<Reply> {
  return await new Promise((resolve, reject) => {
    const host = 'parts.eth'
    const req = request({ host: '127.0.0.1', port, path, servername: host, rejectUnauthorized: false, headers: { host, [EXPECT_LEAF_HEADER]: leaf } }, (res) => {
      let bytes = 0
      res.on('data', (chunk: Buffer) => { bytes += chunk.length })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, bytes, failure: res.headers[FAILURE_HEADER] }) })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

/** The four large files asked for together, as a page's scripts are. */
async function getAllParts (): Promise<Reply[]> {
  const leaves = await Promise.all(PARTS.map(async (path) => await leafOf(path, FILE_BYTES, [SHARED])))
  startRound()
  return await Promise.all(PARTS.map(async (path, at) => await getChecked(path, leaves[at] as string)))
}

const allSent = (replies: Reply[]): unknown => replies.map(({ status, bytes }) => ({ status, bytes }))
const sentWhole = PARTS.map(() => ({ status: 200, bytes: FILE_BYTES }))

describe('the loopback server, sending the files of one app that are asked for together', () => {
  it('sends every one of several large files whose chunks arrive together', async () => {
    // Four such files are more than one partition's share, and a file refused for lack of room is not a 200.
    expect(allSent(await getAllParts())).toEqual(sentWhole)
  }, 30_000)

  it('answers a file larger than an app may carry as a mismatch, without reading it', async () => {
    const reply = await getChecked(HUGE, await leafOf(HUGE, 1, [Buffer.alloc(1)]))
    expect(reply.status).toBe(502)
    expect(reply.failure).toBe(DDOC_MISMATCH)
    expect(hugeBodyRead).toBe(false)
  }, 30_000)

  it('leaves no read in the line after a file that differs, one that fails, or a client that leaves', async () => {
    // A read left in the line would be the oldest of the site for good, and the four files below, none of them the
    // oldest, could never go past the partition's limit: they would wait for each other.
    const differs = await getChecked(SMALL, await leafOf('/other.js', SMALL_BYTES.length, [SMALL_BYTES]))
    expect(differs.status).toBe(502)
    expect(allSent(await getAllParts())).toEqual(sentWhole)

    const fails = await getChecked(BROKEN, await leafOf(BROKEN, FILE_BYTES, [SHARED]))
    expect(fails.status).toBeGreaterThanOrEqual(400)
    expect(allSent(await getAllParts())).toEqual(sentWhole)

    const host = 'parts.eth'
    const leaf = await leafOf(STALLED, FILE_BYTES, [SHARED])
    const leaving = request({ host: '127.0.0.1', port, path: STALLED, servername: host, rejectUnauthorized: false, headers: { host, [EXPECT_LEAF_HEADER]: leaf } })
    leaving.on('error', () => undefined)
    leaving.end()
    await stalledIsReading
    leaving.destroy()
    await stalledHasEnded
    expect(allSent(await getAllParts())).toEqual(sentWhole)
  }, 60_000)
})
