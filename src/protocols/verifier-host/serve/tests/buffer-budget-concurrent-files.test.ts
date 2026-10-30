// Several large files of one app, each asked for with the leaf it must hash to, all at once: together they are more
// than one partition's share of the buffer budget, so every one of them must still be sent, and without a wait.

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
import { EXPECT_LEAF_HEADER } from '../../../../loader/fetch/content-root.js'
import { leafOf } from '../../../../loader/leaf-hash.js'
import { createRunCertificate } from '../certificate.js'
import { createVerifierServer } from '../server.js'
import { RoutedSites, Sites } from '../sites.js'

const ROOT = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const FILE_BYTES = 24 * 1024 * 1024
const CHUNK_BYTES = 256 * 1024
const PATHS = ['/part-0.js', '/part-1.js', '/part-2.js', '/part-3.js']
// One backing store, so four files cost the test one file's memory: a file's chunks are views of it.
const SHARED = Buffer.alloc(FILE_BYTES, 7)

// Every body waits until all of them are opened, then yields a chunk per turn of the event loop: the four reads
// advance together, chunk by chunk, however the connections happened to be set up.
let opened = 0
let allOpened: () => void
const everyFileOpened = new Promise<void>((resolve) => { allOpened = resolve })

function openFile (path: string): GatheredFile {
  if (!PATHS.includes(path)) throw new ResolutionError('not-found', `${path} is not in this site`)
  opened += 1
  if (opened === PATHS.length) allOpened()
  return {
    servedPath: path,
    size: FILE_BYTES,
    body: (async function * () {
      await everyFileOpened
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
  open: async (path) => openFile(path),
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

interface Reply { status: number, bytes: number }

/** The whole of a file asked for with the leaf it must hash to, read as fast as it is sent. */
async function getChecked (path: string, leaf: string): Promise<Reply> {
  return await new Promise((resolve, reject) => {
    const host = 'parts.eth'
    const req = request({ host: '127.0.0.1', port, path, servername: host, rejectUnauthorized: false, headers: { host, [EXPECT_LEAF_HEADER]: leaf } }, (res) => {
      let bytes = 0
      res.on('data', (chunk: Buffer) => { bytes += chunk.length })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, bytes }) })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

describe('the loopback server, sending the files of one app that are asked for together', () => {
  it('sends every one of several large files whose chunks arrive together, without waiting for room', async () => {
    const leaves = await Promise.all(PATHS.map(async (path) => await leafOf(path, FILE_BYTES, [SHARED])))
    const started = Date.now()
    const replies = await Promise.all(PATHS.map(async (path, at) => await getChecked(path, leaves[at] as string)))
    expect(replies).toEqual(PATHS.map(() => ({ status: 200, bytes: FILE_BYTES })))
    // Four such files are more than one partition's share, and a file that gave up waiting for room would take 10 s.
    expect(Date.now() - started).toBeLessThan(6_000)
  }, 30_000)
})
