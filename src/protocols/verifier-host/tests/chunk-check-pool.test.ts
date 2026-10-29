import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { bytesToHex } from 'viem'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildFile } from '../../../../test/apps/swarm-gateway/encode.mjs'
import { GatewayPool } from '../../gateways/gateways.js'
import { cacAddress } from '../../swarm/chunk.js'
import { ChunkSource } from '../../swarm/chunk-fetch.js'
import type { SubtreeLeaf } from '../../swarm/chunk-fetch.js'
import { DEFAULT_LIMITS } from '../../swarm/limits.js'
import { A, fakeSwarm } from '../../swarm/tests/swarm.test-helpers.js'
import { SWARM_ETH } from '../../swarm/tests/live-vectors.js'
import type { CheckedOn } from '../../swarm/chunk-check.js'
import { ChunkCheckPool, defaultPoolSize } from '../chunk-check-pool.js'
import { SwarmChunkDatabase } from '../swarm-chunk-database.js'
import { swarmChunkFile } from '../swarm-chunk-files.js'
import { KeptChunkMemory } from '../swarm-chunk-memory.js'
import type { ChunkCheckPoolOptions } from '../chunk-check-pool.js'
import { builtChunkCheckWorker } from './chunk-check-worker.test-helpers.js'

let code: string
const pools: ChunkCheckPool[] = []

beforeAll(async () => {
  code = await builtChunkCheckWorker()
}, 120_000)

afterEach(() => {
  for (const pool of pools.splice(0)) pool.close()
})

function poolOf (spawn: () => Worker, options: Partial<ChunkCheckPoolOptions> = {}): ChunkCheckPool {
  const made = new ChunkCheckPool({ spawn, ...options })
  pools.push(made)
  return made
}

const real = (): Worker => new Worker(code, { eval: true })
/** A thread that reads a request and ends the thread without answering it. */
const dying = (): Worker => new Worker("require('node:worker_threads').parentPort.on('message', () => process.exit(3))", { eval: true })
/** A thread that takes requests and never answers. */
const silent = (): Worker => new Worker("require('node:worker_threads').parentPort.on('message', () => {})", { eval: true })
/** A thread that answers with something that is not an answer. */
const garbled = (): Worker => new Worker("const p = require('node:worker_threads').parentPort; p.on('message', (m) => p.postMessage({ id: m.id + 1000, ok: true }))", { eval: true })
/** A thread that answers every chunk "not genuine". */
const refusing = (): Worker => new Worker("const p = require('node:worker_threads').parentPort; p.on('message', (m) => p.postMessage({ id: m.id, ok: false }))", { eval: true })
/** A thread that answers every chunk "genuine". */
const approving = (): Worker => new Worker("const p = require('node:worker_threads').parentPort; p.on('message', (m) => p.postMessage({ id: m.id, ok: true }))", { eval: true })
/** A thread that answers with nothing at all. */
const nulled = (): Worker => new Worker("const p = require('node:worker_threads').parentPort; p.on('message', () => p.postMessage(null))", { eval: true })

/** `count` content-addressed chunks, each a different file, and their addresses. */
function chunksOf (count: number): Array<{ address: string, chunk: Uint8Array }> {
  const store = new Map<string, Uint8Array>()
  return Array.from({ length: count }, (_, i) => {
    const { ref } = buildFile(Uint8Array.from({ length: 1 + (i % 4096) }, (_unused, at) => (at * 31 + i) & 255), store)
    return { address: ref, chunk: store.get(ref)! }
  })
}

const FIRST = chunksOf(1)[0]!

describe('the answers of the chunk check pool', () => {
  it('says true for a valid chunk and false for one with a bit flipped, a short one and an empty one, with real threads', async () => {
    const pool = poolOf(real)
    const live = Uint8Array.from(Buffer.from(SWARM_ETH.chunks[SWARM_ETH.feedManifestRoot]!, 'hex'))
    const flipped = new Uint8Array(live)
    flipped[100] = flipped[100]! ^ 1
    expect(await pool.verify(SWARM_ETH.feedManifestRoot, live)).toBe(true)
    expect(await pool.verify(SWARM_ETH.feedManifestRoot, flipped)).toBe(false)
    expect(await pool.verify(SWARM_ETH.feedManifestRoot, live.subarray(0, live.length - 1))).toBe(false)
    expect(await pool.verify(SWARM_ETH.feedManifestRoot, live.subarray(0, 7))).toBe(false)
    expect(await pool.verify(SWARM_ETH.feedManifestRoot, new Uint8Array())).toBe(false)
    expect(await pool.verify(SWARM_ETH.feedManifestRoot, new Uint8Array(4105))).toBe(false)
    expect(pool.threads).toBe(1)
  })

  it('says what the check in place says for hundreds of chunks at once, wrong ones among them, and leaves its callers\' bytes alone', async () => {
    const pool = poolOf(real)
    const chunks = chunksOf(300)
    const wrong = new Set([3, 40, 41, 299])
    const sent = chunks.map(({ chunk }, i) => {
      if (!wrong.has(i)) return chunk
      const copy = new Uint8Array(chunk)
      copy[copy.length - 1] = copy[copy.length - 1]! ^ 1
      return copy
    })
    const before = sent.map((chunk) => new Uint8Array(chunk))
    const answers = await Promise.all(chunks.map(async ({ address }, i) => await pool.verify(address, sent[i]!)))
    expect(answers).toEqual(chunks.map((_chunk, i) => !wrong.has(i)))
    expect(sent).toEqual(before)
    expect(chunks.every(({ address, chunk }) => bytesToHex(cacAddress(chunk)).slice(2) === address)).toBe(true)
  })

  it('checks a view into a larger buffer, as a leaf cut from a bulk answer is', async () => {
    const pool = poolOf(real)
    const backing = new Uint8Array(100 + FIRST.chunk.length + 100).fill(7)
    backing.set(FIRST.chunk, 100)
    expect(await pool.verify(FIRST.address, backing.subarray(100, 100 + FIRST.chunk.length))).toBe(true)
  })
})

describe('where the chunk check pool runs its checks', () => {
  it('starts no thread until a check waits, and another only while every thread has a check', async () => {
    const pool = poolOf(real, { size: 3 })
    expect(pool.threads).toBe(0)
    const where: CheckedOn[] = []
    await pool.verify(FIRST.address, FIRST.chunk, (on) => { where.push(on) })
    expect(pool.threads).toBe(1)
    expect(where).toEqual([1])
    await pool.verify(FIRST.address, FIRST.chunk)
    expect(pool.threads).toBe(1)
    const many = chunksOf(60)
    const seen = new Set<CheckedOn>()
    await Promise.all(many.map(async ({ address, chunk }) => await pool.verify(address, chunk, (on) => { seen.add(on) })))
    expect(pool.threads).toBe(3)
    expect(seen.size).toBeGreaterThan(1)
    expect([...seen].every((on) => typeof on === 'number' && on >= 1 && on <= 3)).toBe(true)
  })

  it('runs at most as many threads as the cores leave to it, three at the most', () => {
    expect(defaultPoolSize()).toBeGreaterThanOrEqual(1)
    expect(defaultPoolSize()).toBeLessThanOrEqual(3)
  })

  it('ends its threads after a quiet while, and starts others for the next check', async () => {
    const pool = poolOf(real, { idleMs: 60 })
    await pool.verify(FIRST.address, FIRST.chunk)
    expect(pool.threads).toBe(1)
    await vi.waitFor(() => { expect(pool.threads).toBe(0) })
    expect(await pool.verify(FIRST.address, FIRST.chunk)).toBe(true)
    expect(pool.threads).toBe(1)
  })

  it('keeps its threads while a check is still out', async () => {
    const pool = poolOf(real, { idleMs: 40 })
    await pool.verify(FIRST.address, FIRST.chunk)
    const many = chunksOf(200)
    const answers = Promise.all(many.map(async ({ address, chunk }) => await pool.verify(address, chunk)))
    expect(pool.threads).toBeGreaterThan(0)
    expect((await answers).every(Boolean)).toBe(true)
  })

  it('ends its threads when it is closed, and checks later chunks in the calling thread', async () => {
    const pool = poolOf(real)
    await pool.verify(FIRST.address, FIRST.chunk)
    pool.close()
    expect(pool.threads).toBe(0)
    const where: CheckedOn[] = []
    expect(await pool.verify(FIRST.address, FIRST.chunk, (on) => { where.push(on) })).toBe(true)
    expect(where).toEqual(['host'])
    expect(pool.threads).toBe(0)
  })

  it('keeps a thread whose answer waited behind the host\'s own busy thread past the stall limit', async () => {
    const lines: string[] = []
    const pool = poolOf(real, { stallMs: 50, log: (line) => { lines.push(line) } })
    await pool.verify(FIRST.address, FIRST.chunk)
    const where: CheckedOn[] = []
    const answer = pool.verify(FIRST.address, FIRST.chunk, (on) => { where.push(on) })
    // The host's thread held by something else, while the thread answers and the stall timer comes due.
    const until = Date.now() + 200
    while (Date.now() < until) { /* busy */ }
    expect(await answer).toBe(true)
    expect(where).toEqual([1])
    expect(lines).toEqual([])
    expect(pool.threads).toBe(1)
  })

  it('settles the checks waiting when it is closed, in the calling thread', async () => {
    const pool = poolOf(silent)
    const chunks = chunksOf(10)
    const where: CheckedOn[] = []
    const answers = Promise.all(chunks.map(async ({ address, chunk }) => await pool.verify(address, chunk, (on) => { where.push(on) })))
    pool.close()
    expect(await answers).toEqual(chunks.map(() => true))
    expect(where).toEqual(chunks.map(() => 'host'))
  })
})

describe('a chunk check pool whose thread fails', () => {
  async function failsToCheckInThread (spawn: () => Worker, why: RegExp, options: Partial<ChunkCheckPoolOptions> = {}): Promise<void> {
    const lines: string[] = []
    const unhandled: unknown[] = []
    const watch = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', watch)
    try {
      const pool = poolOf(spawn, { log: (line) => { lines.push(line) }, ...options })
      const chunks = chunksOf(12)
      const flipped = new Uint8Array(chunks[5]!.chunk)
      flipped[10] = flipped[10]! ^ 1
      const where: CheckedOn[] = []
      const answers = await Promise.all(chunks.map(async ({ address, chunk }, i) => await pool.verify(address, i === 5 ? flipped : chunk, (on) => { where.push(on) })))
      expect(answers).toEqual(chunks.map((_chunk, i) => i !== 5))
      expect(where).toEqual(chunks.map(() => 'host'))
      expect(pool.threads).toBe(0)
      // Checks after the failure are made in the calling thread, with no second line.
      const later: CheckedOn[] = []
      expect(await pool.verify(FIRST.address, FIRST.chunk, (on) => { later.push(on) })).toBe(true)
      expect(later).toEqual(['host'])
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(why)
      expect(lines[0]).not.toContain(FIRST.address)
      await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', watch)
    }
  }

  it('dies in the middle of the checks: every check waiting settles in the calling thread, with one line and no unhandled rejection', async () => {
    await failsToCheckInThread(dying, /a thread exited/)
  })

  it('cannot start: the checks are made in the calling thread', async () => {
    await failsToCheckInThread(() => { throw Object.assign(new Error('/secret/path/worker.js'), { code: 'ERR_WORKER_PATH' }) }, /could not start \(ERR_WORKER_PATH\)/)
  })

  it('has code that does not run: the line names the failure and no path', async () => {
    await failsToCheckInThread(() => new Worker("throw Object.assign(new Error('/secret/path/worker.js'), { code: 'MODULE_NOT_FOUND' })", { eval: true }), /a thread failed/)
  })

  it('goes without answering for too long', async () => {
    await failsToCheckInThread(silent, /no answer in 0\.05 s/, { stallMs: 50 })
  })

  it('sends an answer nobody asked for', async () => {
    await failsToCheckInThread(garbled, /an answer nobody asked for/)
  })

  it('refuses every chunk: a refusal the calling thread does not confirm ends the pool before any answer is used', async () => {
    await failsToCheckInThread(refusing, /refused a chunk the host found genuine/)
  })

  it('takes every chunk as genuine: the altered chunk it is first asked about ends the pool before any answer is used', async () => {
    await failsToCheckInThread(approving, /answered a known chunk wrongly/)
  })

  it('sends an answer that is nothing', async () => {
    await failsToCheckInThread(nulled, /an answer nobody asked for/)
  })

  it('never names the path an error carries', async () => {
    const lines: string[] = []
    const pool = poolOf(() => { throw new Error('/secret/path/worker.js') }, { log: (line) => { lines.push(line) } })
    await pool.verify(FIRST.address, FIRST.chunk)
    expect(lines.join('')).not.toContain('/secret')
  })

  it('takes each check waiting one to a turn of the event loop, so the host is not held for all of them', async () => {
    const pool = poolOf(silent)
    const chunks = chunksOf(40)
    let turns = 0
    let spinning = true
    const spin = (): void => {
      turns++
      if (spinning) setImmediate(spin)
    }
    setImmediate(spin)
    const answers = Promise.all(chunks.map(async ({ address, chunk }) => await pool.verify(address, chunk)))
    pool.close()
    await answers
    spinning = false
    expect(turns).toBeGreaterThanOrEqual(20)
  })
})

describe('a Swarm file read back through the pool, with real threads', () => {
  const SALT = 'cd'.repeat(32)
  const SITE = 'https://one.example'
  const signal = new AbortController().signal

  it('refuses the rows altered on disk, deletes them, and fetches those leaves again, while the others are checked on threads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orivon-chunk-check-'))
    const databases: SwarmChunkDatabase[] = []
    const database = (): SwarmChunkDatabase => {
      const made = new SwarmChunkDatabase({ dir, salt: SALT })
      databases.push(made)
      return made
    }
    try {
      const store = new Map<string, Uint8Array>()
      const content = Uint8Array.from({ length: 12 * 4096 }, (_, i) => Math.imul(i ^ (i >>> 5), 2_246_822_519) >>> 24)
      const parent = buildFile(content, store).ref
      const refs = store.get(parent)!.subarray(8)
      const leaves: SubtreeLeaf[] = Array.from({ length: 12 }, (_, i) => ({ address: bytesToHex(refs.subarray(i * 32, (i + 1) * 32)).slice(2), size: 4096, offset: i * 4096 }))
      const pool = poolOf(real)
      const sourceOver = (disk: SwarmChunkDatabase) => {
        const swarm = fakeSwarm(store)
        const deps = { fetch: swarm.fetch, pool: new GatewayPool([A], 6), limits: DEFAULT_LIMITS, checker: pool }
        return { source: new ChunkSource(deps, new KeptChunkMemory(disk, '', pool), SITE), requests: swarm.requests }
      }
      const first = database()
      await Promise.all(sourceOver(first).source.leaves(parent, leaves, signal, () => {}))
      first.close()
      const raw = new DatabaseSync(join(dir, swarmChunkFile(SALT)))
      for (const at of [2, 7]) raw.prepare('UPDATE chunk SET bytes = zeroblob(length(bytes)) WHERE address = ?').run(Buffer.from(leaves[at]!.address, 'hex'))
      raw.close()

      const second = database()
      const { source, requests } = sourceOver(second)
      expect(await Promise.all(source.leaves(parent, leaves, signal, () => {}))).toEqual(leaves.map((leaf) => store.get(leaf.address)))
      expect(requests).toEqual([`${A}/bytes/${parent}`])
      expect(second.refused).toBe(2)
      expect(second.fromDisk).toBe(10)
      expect(pool.threads).toBeGreaterThan(0)
    } finally {
      for (const database of databases) database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('drops a refused row only while it still holds the bytes refused, so a late refusal leaves the chunk fetched again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orivon-chunk-check-'))
    const disk = new SwarmChunkDatabase({ dir, salt: SALT })
    try {
      disk.put(SITE, FIRST.address, FIRST.chunk)
      disk.flush()
      const raw = new DatabaseSync(join(dir, swarmChunkFile(SALT)))
      raw.prepare('UPDATE chunk SET bytes = zeroblob(length(bytes)) WHERE address = ?').run(Buffer.from(FIRST.address, 'hex'))
      raw.close()
      // Two reads of the altered row, whose checks settle one after the other with the chunk fetched again between them.
      const early = disk.read(SITE, FIRST.address)!
      const late = disk.read(SITE, FIRST.address)!
      expect(disk.settle(early, false)).toBeUndefined()
      disk.put(SITE, FIRST.address, FIRST.chunk)
      disk.flush()
      expect(disk.settle(late, false)).toBeUndefined()
      expect(disk.get(SITE, FIRST.address)).toEqual(FIRST.chunk)
      expect(disk.refused).toBe(1)
    } finally {
      disk.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
