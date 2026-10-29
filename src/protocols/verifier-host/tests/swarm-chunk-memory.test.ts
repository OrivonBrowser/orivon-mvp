import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { bytesToHex, concat } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFile, buildSite } from '../../../../test/apps/swarm-gateway/encode.mjs'
import { GatewayPool } from '../../gateways/gateways.js'
import type { NameRecord } from '../../resolution/records.js'
import { ChunkSource } from '../../swarm/chunk-fetch.js'
import type { SubtreeLeaf } from '../../swarm/chunk-fetch.js'
import { checkHere } from '../../swarm/chunk-check.js'
import type { CheckedOn, ChunkChecker } from '../../swarm/chunk-check.js'
import { DEFAULT_LIMITS } from '../../swarm/limits.js'
import { createSwarmGatherer } from '../../swarm/gatherer.js'
import type { FeedIndexStore } from '../../swarm/feed.js'
import { referenceCid } from '../../swarm/reference.js'
import { A, fakeSwarm, text } from '../../swarm/tests/swarm.test-helpers.js'
import { SwarmChunkDatabase } from '../swarm-chunk-database.js'
import { swarmChunkFile } from '../swarm-chunk-files.js'
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
  it('answers from its cache without the disk, from the disk when asked there, and a chunk taken from the disk answers from the cache after', async () => {
    const store = new Map<string, Uint8Array>()
    const { ref } = buildFile(new Uint8Array(4096).fill(9), store)
    const chunk = store.get(ref)!
    const first = database()
    first.put(SITE, ref, chunk)
    first.close()

    const disk = database()
    const memory = new KeptChunkMemory(disk)
    expect(memory.recall(SITE, ref)).toBeUndefined()
    expect(disk.fromDisk).toBe(0)
    expect(await memory.recallKept(SITE, ref)).toEqual(chunk)
    expect(disk.fromDisk).toBe(1)
    expect(memory.recall(SITE, ref)).toEqual(chunk)
    expect(disk.fromDisk).toBe(1)
  })

  it('reads the disk one chunk at a time, the event loop turning between two reads', async () => {
    const store = new Map<string, Uint8Array>()
    const refs = Array.from({ length: 20 }, (_, i) => buildFile(new Uint8Array(4096).fill(i + 1), store).ref)
    const first = database()
    for (const ref of refs) first.put(SITE, ref, store.get(ref)!)
    first.close()

    const memory = new KeptChunkMemory(database())
    let turns = 0
    let reading = true
    const spin = (): void => {
      turns++
      if (reading) setImmediate(spin)
    }
    setImmediate(spin)
    const answers = await Promise.all(refs.map(async (ref) => await memory.recallKept(SITE, ref)))
    reading = false
    expect(answers).toEqual(refs.map((ref) => store.get(ref)))
    expect(turns).toBeGreaterThanOrEqual(refs.length)
  })

  it('answers undefined, never an error, when the disk fails', async () => {
    const broken = { get: () => { throw new Error('the disk is gone') }, touch: () => {}, put: () => {} } as unknown as SwarmChunkDatabase
    await expect(new KeptChunkMemory(broken).recallKept(SITE, 'ab'.repeat(32))).resolves.toBeUndefined()
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

  it('keeps the chunks of one route apart from those of another on the disk, as it does in memory', async () => {
    const store = new Map<string, Uint8Array>()
    const { ref } = buildFile(new Uint8Array(100).fill(3), store)
    const chunk = store.get(ref)!
    const disk = database()
    new KeptChunkMemory(disk, 'nym').remember(SITE, ref, chunk)
    disk.flush()
    expect(await new KeptChunkMemory(disk).recallKept(SITE, ref)).toBeUndefined()
    expect(await new KeptChunkMemory(disk, 'socks5').recallKept(SITE, ref)).toBeUndefined()
    expect(await new KeptChunkMemory(disk, 'nym').recallKept(SITE, ref)).toEqual(chunk)
  })

  it('does not hand the disk to a site that did not fetch the chunk', async () => {
    const store = new Map<string, Uint8Array>()
    const { ref } = buildFile(new Uint8Array(100).fill(3), store)
    const disk = database()
    new KeptChunkMemory(disk).remember(SITE, ref, store.get(ref)!)
    expect(await new KeptChunkMemory(disk).recallKept('https://two.example', ref)).toBeUndefined()
  })
})

describe('a chunk source over the chunk database', () => {
  const signal = new AbortController().signal

  /** A file of six leaves under one intermediate chunk, and a source that reads it from `swarm` through `disk`. */
  function file () {
    const store = new Map<string, Uint8Array>()
    const content = Uint8Array.from({ length: 6 * 4096 }, (_, i) => Math.imul(i ^ (i >>> 5), 2_246_822_519) >>> 24)
    const parent = buildFile(content, store).ref
    const refs = store.get(parent)!.subarray(8)
    const leaves: SubtreeLeaf[] = Array.from({ length: 6 }, (_, i) => ({ address: bytesToHex(refs.subarray(i * 32, (i + 1) * 32)).slice(2), size: 4096, offset: i * 4096 }))
    const sourceOver = (disk: SwarmChunkDatabase, checker?: ChunkChecker): { source: ChunkSource, requests: string[] } => {
      const swarm = fakeSwarm(store)
      const deps = { fetch: swarm.fetch, pool: new GatewayPool([A], 6), limits: DEFAULT_LIMITS, ...(checker !== undefined && { checker }) }
      return { source: new ChunkSource(deps, new KeptChunkMemory(disk, '', checker), SITE), requests: swarm.requests }
    }
    return { store, parent, leaves, sourceOver }
  }

  it('reads the leaves of a file seen before from the disk, and asks the node for none', async () => {
    const { store, parent, leaves, sourceOver } = file()
    const first = database()
    await Promise.all(sourceOver(first).source.leaves(parent, leaves, signal, () => {}))
    first.close()

    const second = database()
    const { source, requests } = sourceOver(second)
    expect(await Promise.all(source.leaves(parent, leaves, signal, () => {}))).toEqual(leaves.map((leaf) => store.get(leaf.address)))
    expect(requests).toEqual([])
    expect(second.fromDisk).toBe(6)
  })

  it('fetches again the leaves whose rows fail their address, with a checker of its own in use, and serves the right bytes', async () => {
    const { store, parent, leaves, sourceOver } = file()
    const checker: ChunkChecker = { verify: async (address, chunk) => { await new Promise<void>((resolve) => { setTimeout(resolve, 2) }); return checkHere(address, chunk) } }
    const first = database()
    await Promise.all(sourceOver(first, checker).source.leaves(parent, leaves, signal, () => {}))
    first.close()
    const raw = new DatabaseSync(join(dir, swarmChunkFile(SALT)))
    for (const at of [0, 3]) raw.prepare('UPDATE chunk SET bytes = zeroblob(length(bytes)) WHERE address = ?').run(Buffer.from(leaves[at]!.address, 'hex'))
    raw.close()

    const second = database()
    const { source, requests } = sourceOver(second, checker)
    expect(await Promise.all(source.leaves(parent, leaves, signal, () => {}))).toEqual(leaves.map((leaf) => store.get(leaf.address)))
    expect(requests).toEqual([`${A}/bytes/${parent}`])
    expect(second.refused).toBe(2)
    expect(second.fromDisk).toBe(4)
  })

  it('fetches again the leaves whose rows fail their address, in one request, and serves the right bytes', async () => {
    const { store, parent, leaves, sourceOver } = file()
    const first = database()
    await Promise.all(sourceOver(first).source.leaves(parent, leaves, signal, () => {}))
    first.close()
    const raw = new DatabaseSync(join(dir, swarmChunkFile(SALT)))
    for (const at of [1, 4]) raw.prepare('UPDATE chunk SET bytes = zeroblob(length(bytes)) WHERE address = ?').run(Buffer.from(leaves[at]!.address, 'hex'))
    raw.close()

    const second = database()
    const { source, requests } = sourceOver(second)
    expect(await Promise.all(source.leaves(parent, leaves, signal, () => {}))).toEqual(leaves.map((leaf) => store.get(leaf.address)))
    expect(requests).toEqual([`${A}/bytes/${parent}`])
    expect(second.refused).toBe(2)
    expect(second.fromDisk).toBe(4)
  })
})

/** A checker that holds each check until the test releases it, then makes the real one on "thread" 1. */
function heldChecker () {
  const held: Array<{ readonly address: string, readonly release: () => void }> = []
  const checker: ChunkChecker = {
    verify: async (address, chunk, ran) => {
      await new Promise<void>((release) => { held.push({ address, release }) })
      ran?.(1)
      return checkHere(address, chunk)
    }
  }
  return { checker, held }
}

describe('the memory in front of the chunk database, with a checker of its own', () => {
  function kept (count: number) {
    const store = new Map<string, Uint8Array>()
    const refs = Array.from({ length: count }, (_, i) => buildFile(new Uint8Array(4096).fill(i + 1), store).ref)
    const first = database()
    for (const ref of refs) first.put(SITE, ref, store.get(ref)!)
    first.close()
    return { store, refs }
  }

  it('has a row read back checked there, tells where, and answers it from the cache after', async () => {
    const { store, refs } = kept(1)
    const { checker, held } = heldChecker()
    const disk = database()
    const memory = new KeptChunkMemory(disk, '', checker)
    const where: CheckedOn[] = []
    const answer = memory.recallKept(SITE, refs[0]!, (on) => { where.push(on) })
    await vi.waitFor(() => { expect(held).toHaveLength(1) })
    expect(disk.fromDisk).toBe(0)
    held[0]!.release()
    expect(await answer).toEqual(store.get(refs[0]!))
    expect(where).toEqual([1])
    expect(disk.fromDisk).toBe(1)
    expect(memory.recall(SITE, refs[0]!)).toEqual(store.get(refs[0]!))
  })

  it('reads the next rows while earlier ones are being checked', async () => {
    const { store, refs } = kept(5)
    const { checker, held } = heldChecker()
    const memory = new KeptChunkMemory(database(), '', checker)
    const answers = refs.map(async (ref) => await memory.recallKept(SITE, ref))
    await vi.waitFor(() => { expect(held.map((check) => check.address)).toEqual(refs) })
    for (const check of [...held].reverse()) check.release()
    expect(await Promise.all(answers)).toEqual(refs.map((ref) => store.get(ref)))
  })

  it('refuses a row altered on disk, deletes it, and keeps the ones around it', async () => {
    const { store, refs } = kept(3)
    const raw = new DatabaseSync(join(dir, swarmChunkFile(SALT)))
    raw.prepare('UPDATE chunk SET bytes = zeroblob(length(bytes)) WHERE address = ?').run(Buffer.from(refs[1]!, 'hex'))
    raw.close()
    const { checker, held } = heldChecker()
    const disk = database()
    const memory = new KeptChunkMemory(disk, '', checker)
    const answers = refs.map(async (ref) => await memory.recallKept(SITE, ref))
    await vi.waitFor(() => { expect(held).toHaveLength(3) })
    for (const check of held) check.release()
    expect(await Promise.all(answers)).toEqual([store.get(refs[0]!), undefined, store.get(refs[2]!)])
    expect(disk.refused).toBe(1)
    expect(disk.fromDisk).toBe(2)
    disk.close()
    const check = new DatabaseSync(join(dir, swarmChunkFile(SALT)))
    expect((check.prepare('SELECT count(*) AS n FROM chunk').get() as { n: number }).n).toBe(2)
    check.close()
  })

  it('drops nothing when the file was closed while the check of an altered row was out, and still refuses the row', async () => {
    const { refs } = kept(1)
    const raw = new DatabaseSync(join(dir, swarmChunkFile(SALT)))
    raw.prepare('UPDATE chunk SET bytes = zeroblob(length(bytes))').run()
    raw.close()
    const { checker, held } = heldChecker()
    const disk = database()
    const memory = new KeptChunkMemory(disk, '', checker)
    const answer = memory.recallKept(SITE, refs[0]!)
    await vi.waitFor(() => { expect(held).toHaveLength(1) })
    disk.close()
    held[0]!.release()
    expect(await answer).toBeUndefined()
    expect(disk.refused).toBe(0)
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
