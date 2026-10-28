import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { concat } from 'viem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildFile, buildSite } from '../../../../test/apps/swarm-gateway/encode.mjs'
import type { NameRecord } from '../../resolution/records.js'
import { createSwarmGatherer } from '../../swarm/gatherer.js'
import type { FeedIndexStore } from '../../swarm/feed.js'
import { referenceCid } from '../../swarm/reference.js'
import { A, fakeSwarm, text } from '../../swarm/tests/swarm.test-helpers.js'
import { SwarmChunkDatabase } from '../swarm-chunk-database.js'
import { KeptChunkMemory } from '../swarm-chunk-memory.js'

const SALT = 'ab'.repeat(32)
const SITE = 'https://one.example'
const BIG = Uint8Array.from({ length: 40_000 }, (_, i) => (i * 7 + (i >> 8)) % 256)
/** Over 256 KB, which is what a file read must be before the gatherer logs it, and every 4 KB chunk of it different. */
const HUGE = Uint8Array.from({ length: 300_000 }, (_, i) => Math.imul(i ^ (i >>> 7), 2_654_435_761) >>> 24)
const FILES = { 'index.html': '<h1>home</h1>', 'style.css': 'body{}', 'docs/guide.html': '<h1>guide</h1>' }

let dir: string
let databases: SwarmChunkDatabase[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-swarm-memory-'))
  databases = []
})

afterEach(() => {
  for (const database of databases) database.close()
  rmSync(dir, { recursive: true, force: true })
})

function database (salt = SALT): SwarmChunkDatabase {
  const made = new SwarmChunkDatabase({ dir, salt })
  databases.push(made)
  return made
}

describe('the memory in front of the chunk database', () => {
  it('asks its cache first, then the disk, and answers a chunk it took from the disk from its cache after', () => {
    const store = new Map<string, Uint8Array>()
    const { ref } = buildFile(new Uint8Array(4096).fill(9), store)
    const chunk = store.get(ref)!
    const first = database()
    first.put(SITE, ref, chunk)
    first.close()

    const disk = database()
    const memory = new KeptChunkMemory(disk)
    expect(memory.recall(SITE, ref)).toEqual(chunk)
    expect(memory.recalledFromDisk()).toBe(1)
    expect(memory.recall(SITE, ref)).toEqual(chunk)
    expect(memory.recalledFromDisk()).toBe(1)
  })

  it('writes what it remembers to the disk too', () => {
    const store = new Map<string, Uint8Array>()
    const { ref } = buildFile(new Uint8Array(100).fill(3), store)
    const chunk = store.get(ref)!
    const writer = database()
    new KeptChunkMemory(writer).remember(SITE, ref, chunk)
    writer.close()
    expect(database().get(SITE, ref)).toEqual(chunk)
  })

  it('keeps the chunks of one route apart from those of another on the disk, as it does in memory', () => {
    const store = new Map<string, Uint8Array>()
    const { ref } = buildFile(new Uint8Array(100).fill(3), store)
    const chunk = store.get(ref)!
    const disk = database()
    new KeptChunkMemory(disk, 'nym').remember(SITE, ref, chunk)
    disk.flush()
    expect(new KeptChunkMemory(disk).recall(SITE, ref)).toBeUndefined()
    expect(new KeptChunkMemory(disk, 'socks5').recall(SITE, ref)).toBeUndefined()
    expect(new KeptChunkMemory(disk, 'nym').recall(SITE, ref)).toEqual(chunk)
  })

  it('does not hand the disk to a site that did not fetch the chunk', () => {
    const store = new Map<string, Uint8Array>()
    const { ref } = buildFile(new Uint8Array(100).fill(3), store)
    const disk = database()
    new KeptChunkMemory(disk).remember(SITE, ref, store.get(ref)!)
    expect(new KeptChunkMemory(disk).recall('https://two.example', ref)).toBeUndefined()
  })
})

function recordFor (reference: string): NameRecord {
  return { type: 'contenthash', pointer: { kind: 'swarm', cid: referenceCid(reference) }, provenance: { via: 'chain', block: 100, offchain: false } }
}

const feeds: FeedIndexStore = { highest: () => undefined, record: () => {} }

function gathererOver (chunks: Map<string, Uint8Array>, disk: SwarmChunkDatabase, lines: string[] = []) {
  const swarm = fakeSwarm(chunks)
  const gatherer = createSwarmGatherer({ fetch: swarm.fetch, endpoints: [A], feedIndexes: feeds, memory: new KeptChunkMemory(disk), log: (line) => { lines.push(line) } })
  return { swarm, gatherer }
}

async function read (site: Awaited<ReturnType<ReturnType<typeof createSwarmGatherer>['mount']>>, path: string): Promise<Uint8Array> {
  const file = await site.open(path)
  const parts: Uint8Array[] = []
  for await (const part of file.body) parts.push(part)
  return concat(parts)
}

const asked = (requests: readonly string[]): string[] => requests.filter((url) => /\/(chunks|bytes)\//.test(url))

describe('a Swarm gatherer over the chunk database', () => {
  it('mounts a site a first gatherer read and asks the node for no chunk, from another database over the same directory and salt', async () => {
    const chunks = new Map<string, Uint8Array>()
    const root = buildSite({ ...FILES, 'big.bin': BIG }, chunks)
    const first = gathererOver(chunks, database())
    const site = await first.gatherer.mount('site.eth', [recordFor(root)], undefined, SITE)
    expect(text(await read(site, '/style.css'))).toBe('body{}')
    expect(await read(site, '/big.bin')).toEqual(BIG)
    expect(asked(first.swarm.requests).length).toBeGreaterThan(0)
    databases[0]!.close()

    const lines: string[] = []
    const second = gathererOver(chunks, database(), lines)
    const again = await second.gatherer.mount('site.eth', [recordFor(root)], undefined, SITE)
    expect(text(await read(again, '/style.css'))).toBe('body{}')
    expect(await read(again, '/big.bin')).toEqual(BIG)
    expect(asked(second.swarm.requests)).toEqual([])
    expect(again.ddoc()).toEqual({ status: 'met', refusals: [] })
    expect(lines.some((line) => /a site mounted in .* [1-9]\d* chunks from disk/.test(line))).toBe(true)
  })

  it('counts the chunks from disk of one file read on its own, however many others are being read at once', async () => {
    const chunks = new Map<string, Uint8Array>()
    const root = buildSite({ ...FILES, 'huge.bin': HUGE }, chunks)
    const first = gathererOver(chunks, database())
    const seen = await first.gatherer.mount('site.eth', [recordFor(root)], undefined, SITE)
    await read(seen, '/huge.bin')
    await read(seen, '/style.css')
    databases[0]!.close()

    const lines: string[] = []
    const second = gathererOver(chunks, database(), lines)
    const site = await second.gatherer.mount('site.eth', [recordFor(root)], undefined, SITE)
    const tally = (pattern: RegExp): number => Number(pattern.exec(lines.find((line) => pattern.test(line)) ?? '')?.[1] ?? 0)
    const mounted = tally(/a site mounted .*, (\d+) chunks from disk\)/)
    const [small, huge] = await Promise.all([site.open('/style.css'), site.open('/huge.bin')])
    for (const file of [small, huge]) for await (const part of file.body) void part
    const hugeChunks = tally(/a file read, 300000 bytes .* (\d+) chunks from disk$/)
    expect(hugeChunks).toBeGreaterThanOrEqual(Math.ceil(HUGE.length / 4096))
    expect(mounted + hugeChunks).toBeLessThan(databases[1]!.fromDisk)
    expect(asked(second.swarm.requests)).toEqual([])
  })

  it('asks the node for what the first gatherer did not read, and for nothing else', async () => {
    const chunks = new Map<string, Uint8Array>()
    const root = buildSite({ ...FILES, 'big.bin': BIG }, chunks)
    const first = gathererOver(chunks, database())
    await read(await first.gatherer.mount('site.eth', [recordFor(root)], undefined, SITE), '/style.css')
    databases[0]!.close()

    const second = gathererOver(chunks, database())
    const site = await second.gatherer.mount('site.eth', [recordFor(root)], undefined, SITE)
    await read(site, '/style.css')
    expect(asked(second.swarm.requests)).toEqual([])
    expect(await read(site, '/big.bin')).toEqual(BIG)
    expect(asked(second.swarm.requests).length).toBeGreaterThan(0)
  })

  it('asks the node again for another site, which has no chunk of its own on the disk', async () => {
    const chunks = new Map<string, Uint8Array>()
    const root = buildSite(FILES, chunks)
    const first = gathererOver(chunks, database())
    await read(await first.gatherer.mount('site.eth', [recordFor(root)], undefined, SITE), '/style.css')
    databases[0]!.close()

    const second = gathererOver(chunks, database())
    await read(await second.gatherer.mount('site.eth', [recordFor(root)], undefined, 'https://two.example'), '/style.css')
    expect(asked(second.swarm.requests).length).toBeGreaterThan(0)
  })

  it('keeps nothing for a mount with no partition', async () => {
    const chunks = new Map<string, Uint8Array>()
    const root = buildSite(FILES, chunks)
    const first = gathererOver(chunks, database())
    await read(await first.gatherer.mount('site.eth', [recordFor(root)]), '/style.css')
    databases[0]!.close()

    const second = gathererOver(chunks, database())
    await read(await second.gatherer.mount('site.eth', [recordFor(root)]), '/style.css')
    expect(asked(second.swarm.requests).length).toBeGreaterThan(0)
  })

  it('refetches a chunk whose kept bytes fail their address, and serves the right bytes', async () => {
    const chunks = new Map<string, Uint8Array>()
    const root = buildSite(FILES, chunks)
    const first = gathererOver(chunks, database())
    await read(await first.gatherer.mount('site.eth', [recordFor(root)], undefined, SITE), '/style.css')
    databases[0]!.close()
    const { DatabaseSync } = await import('node:sqlite')
    const { swarmChunkFile } = await import('../swarm-chunk-files.js')
    const raw = new DatabaseSync(join(dir, swarmChunkFile(SALT)))
    raw.exec('UPDATE chunk SET bytes = zeroblob(length(bytes))')
    raw.close()

    const second = gathererOver(chunks, database())
    const site = await second.gatherer.mount('site.eth', [recordFor(root)], undefined, SITE)
    expect(text(await read(site, '/style.css'))).toBe('body{}')
    expect(asked(second.swarm.requests).length).toBeGreaterThan(0)
    expect(databases[1]!.refused).toBeGreaterThan(0)
  })
})
