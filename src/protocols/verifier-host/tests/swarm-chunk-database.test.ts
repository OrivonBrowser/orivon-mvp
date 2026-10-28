import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFile } from '../../../../test/apps/swarm-gateway/encode.mjs'
import { SwarmChunkDatabase } from '../swarm-chunk-database.js'
import type { SwarmChunkDatabaseOptions } from '../swarm-chunk-database.js'
import { swarmChunkFile } from '../swarm-chunk-files.js'

const SALT = 'ab'.repeat(32)
const OTHER_SALT = 'cd'.repeat(32)
const SITE = 'https://one.example'
const CHUNK = 4104

interface Kept { readonly address: string, readonly bytes: Uint8Array }

/** `count` distinct valid content-addressed chunks, each a whole 4 KB leaf. */
function chunks (count: number, seed = 1): Kept[] {
  return Array.from({ length: count }, (_, i) => {
    const store = new Map<string, Uint8Array>()
    const { ref } = buildFile(new Uint8Array(4096).fill(((seed * 31 + i) % 250) + 1).map((byte, at) => (byte + at * (i + seed)) % 256), store)
    return { address: ref, bytes: store.get(ref)! }
  })
}

let dir: string
let opened: SwarmChunkDatabase[]
let lines: string[]

function database (options: Partial<SwarmChunkDatabaseOptions> = {}): SwarmChunkDatabase {
  const made = new SwarmChunkDatabase({ dir, salt: SALT, log: (line) => { lines.push(line) }, ...options })
  opened.push(made)
  return made
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-swarm-chunks-'))
  opened = []
  lines = []
})

afterEach(() => {
  for (const made of opened) made.close()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('the Swarm chunk database', () => {
  it('gives a chunk back after the store is closed and opened again', () => {
    const [chunk] = chunks(1)
    const first = database()
    first.put(SITE, chunk!.address, chunk!.bytes)
    first.close()
    const second = database()
    expect(second.get(SITE, chunk!.address)).toEqual(chunk!.bytes)
    expect(second.fromDisk).toBe(1)
  })

  it('answers from what is still waiting to be written', () => {
    const [chunk] = chunks(1)
    const store = database()
    store.put(SITE, chunk!.address, chunk!.bytes)
    expect(store.get(SITE, chunk!.address)).toEqual(chunk!.bytes)
  })

  it('never gives one site the chunks of another', () => {
    const [chunk] = chunks(1)
    const store = database()
    store.put(SITE, chunk!.address, chunk!.bytes)
    store.flush()
    expect(store.get('https://two.example', chunk!.address)).toBeUndefined()
    expect(store.get(SITE, chunk!.address)).toEqual(chunk!.bytes)
  })

  it('keeps no site in plain text, and a replaced salt finds nothing', () => {
    const [chunk] = chunks(1)
    const first = database()
    first.put(SITE, chunk!.address, chunk!.bytes)
    first.close()
    expect(readFileSync(join(dir, swarmChunkFile(SALT))).includes(Buffer.from('one.example'))).toBe(false)
    const replaced = database({ salt: OTHER_SALT })
    expect(replaced.get(SITE, chunk!.address)).toBeUndefined()
  })

  it('refuses a row whose bytes no longer hash to its address, deletes it, and says so once without naming it', () => {
    const [chunk] = chunks(1)
    const first = database()
    first.put(SITE, chunk!.address, chunk!.bytes)
    first.close()
    const raw = new DatabaseSync(join(dir, swarmChunkFile(SALT)))
    const flipped = chunk!.bytes.slice()
    flipped[100] = flipped[100]! ^ 1
    raw.prepare('UPDATE chunk SET bytes = ?').run(flipped)
    raw.close()

    const second = database()
    expect(second.get(SITE, chunk!.address)).toBeUndefined()
    expect(second.get(SITE, chunk!.address)).toBeUndefined()
    expect(second.refused).toBe(1)
    expect(second.fromDisk).toBe(0)
    second.close()
    const check = new DatabaseSync(join(dir, swarmChunkFile(SALT)))
    expect((check.prepare('SELECT count(*) AS n FROM chunk').get() as { n: number }).n).toBe(0)
    check.close()
    expect(lines.filter((line) => line.includes('failed its address'))).toHaveLength(1)
    expect(lines.join('\n')).not.toContain(chunk!.address)
  })

  it('refuses a row that holds something other than bytes, as it does bytes that fail their address', () => {
    const [chunk] = chunks(1)
    const first = database()
    first.put(SITE, chunk!.address, chunk!.bytes)
    first.close()
    const raw = new DatabaseSync(join(dir, swarmChunkFile(SALT)))
    raw.exec("UPDATE chunk SET bytes = 'not bytes at all'")
    raw.close()
    const second = database()
    expect(second.get(SITE, chunk!.address)).toBeUndefined()
    expect(second.refused).toBe(1)
  })

  it('drops the least recently used chunks first once the cap is passed, and counts the cap across runs', () => {
    let minute = 1000
    const options = { maxBytes: 10 * CHUNK, now: () => minute * 60_000 }
    const kept = chunks(14)
    const store = database(options)
    for (const chunk of kept.slice(0, 8)) store.put(SITE, chunk.address, chunk.bytes)
    store.flush()
    minute += 5
    expect(store.get(SITE, kept[0]!.address)).toEqual(kept[0]!.bytes)
    store.flush()
    store.close()

    const next = database(options)
    minute += 5
    for (const chunk of kept.slice(8)) next.put(SITE, chunk.address, chunk.bytes)
    next.flush()
    const left = kept.filter((chunk) => next.get(SITE, chunk.address) !== undefined).map((chunk) => kept.indexOf(chunk))
    expect(left).toContain(0)
    expect(left).toEqual(expect.arrayContaining([8, 9, 10, 11, 12, 13]))
    expect(left).not.toContain(1)
    expect(left).not.toContain(2)
    expect(left.length).toBeLessThanOrEqual(10)
    expect(left.length).toBeGreaterThanOrEqual(8)
  })

  it('counts a chunk the memory above answered as used, so it outlives one nobody asked for', () => {
    let minute = 1000
    const options = { maxBytes: 6 * CHUNK, now: () => minute * 60_000 }
    const kept = chunks(8)
    const store = database(options)
    for (const chunk of kept.slice(0, 5)) store.put(SITE, chunk.address, chunk.bytes)
    store.flush()
    minute += 5
    store.touch(SITE, kept[0]!.address)
    store.flush()
    minute += 5
    for (const chunk of kept.slice(5)) store.put(SITE, chunk.address, chunk.bytes)
    store.flush()
    const left = kept.map((chunk, at) => (store.get(SITE, chunk.address) === undefined ? -1 : at)).filter((at) => at >= 0)
    expect(left).toContain(0)
    expect(left).not.toContain(1)
  })

  it('ages rows by its own count of minutes of use, so a clock that was far ahead and is right now does not keep the old rows', () => {
    let minute = 5_000_000
    const options = { maxBytes: 10 * CHUNK, now: () => minute * 60_000 }
    const old = chunks(8, 1)
    const fresh = chunks(6, 2)
    const first = database(options)
    for (const chunk of old) first.put(SITE, chunk.address, chunk.bytes)
    first.close()

    minute = 1000
    const next = database(options)
    for (const chunk of fresh) next.put(SITE, chunk.address, chunk.bytes)
    next.flush()
    expect(fresh.every((chunk) => next.get(SITE, chunk.address) !== undefined)).toBe(true)
    expect(old.filter((chunk) => next.get(SITE, chunk.address) !== undefined).length).toBeLessThan(old.length)
  })

  it('does not write a mark for the same chunk twice in a minute', () => {
    let minute = 1000
    const [chunk] = chunks(1)
    const store = database({ now: () => minute * 60_000 })
    store.put(SITE, chunk!.address, chunk!.bytes)
    store.flush()
    const reader = new DatabaseSync(join(dir, swarmChunkFile(SALT)))
    const used = (): number => (reader.prepare('SELECT used FROM age').get() as { used: number }).used
    const first = used()
    minute += 5
    store.get(SITE, chunk!.address)
    store.touch(SITE, chunk!.address)
    store.flush()
    const second = used()
    expect(second).toBeGreaterThan(first)
    store.touch(SITE, chunk!.address)
    store.get(SITE, chunk!.address)
    store.flush()
    expect(used()).toBe(second)
    reader.close()
  })

  it('deletes the files of an older salt when it opens, and no other file', () => {
    const [chunk] = chunks(1)
    const old = database({ salt: OTHER_SALT })
    old.put(SITE, chunk!.address, chunk!.bytes)
    old.close()
    writeFileSync(join(dir, `${swarmChunkFile(OTHER_SALT)}-journal`), 'x')
    writeFileSync(join(dir, 'checkpoint.json'), '{}')
    expect(readdirSync(dir)).toContain(swarmChunkFile(OTHER_SALT))

    const present = database()
    expect(present.get(SITE, chunk!.address)).toBeUndefined()
    const files = readdirSync(dir).filter((name) => name.startsWith('swarm-chunks-'))
    expect(files).toContain(swarmChunkFile(SALT))
    expect(files.every((name) => name.startsWith(swarmChunkFile(SALT)))).toBe(true)
    expect(readdirSync(dir)).toContain('checkpoint.json')
  })

  it('runs memory-only and says so once when the directory cannot be made', () => {
    const blocker = join(dir, 'a-file')
    writeFileSync(blocker, 'x')
    const [chunk] = chunks(1)
    const store = database({ dir: join(blocker, 'verifier') })
    expect(() => { store.put(SITE, chunk!.address, chunk!.bytes) }).not.toThrow()
    expect(store.get(SITE, chunk!.address)).toBeUndefined()
    store.flush()
    expect(lines.filter((line) => line.includes('chunk store'))).toHaveLength(1)
    expect(lines.join('\n')).not.toContain(dir)
  })

  it('deletes a file that is not a database and starts a new one', () => {
    writeFileSync(join(dir, swarmChunkFile(SALT)), Buffer.alloc(5000, 7))
    const [chunk] = chunks(1)
    const store = database()
    store.put(SITE, chunk!.address, chunk!.bytes)
    store.close()
    expect(database().get(SITE, chunk!.address)).toEqual(chunk!.bytes)
  })

  it('makes the file again, once and with a line, when it turns out to be damaged while in use, and runs without it the second time', () => {
    const kept = chunks(20)
    const first = database()
    for (const chunk of kept) first.put(SITE, chunk.address, chunk.bytes)
    first.close()
    const damage = (): void => {
      const path = join(dir, swarmChunkFile(SALT))
      const bytes = readFileSync(path)
      bytes.fill(0xff, 32768, 65536)
      writeFileSync(path, bytes)
    }
    damage()

    const store = database()
    expect(store.get(SITE, kept[0]!.address)).toBeUndefined()
    expect(lines.filter((line) => line.includes('damaged'))).toHaveLength(1)
    store.put(SITE, kept[1]!.address, kept[1]!.bytes)
    store.flush()
    expect(store.get(SITE, kept[1]!.address)).toEqual(kept[1]!.bytes)
    store.close()

    damage()
    expect(store.get(SITE, kept[1]!.address)).toBeUndefined()
    expect(() => { store.put(SITE, kept[2]!.address, kept[2]!.bytes) }).not.toThrow()
    expect(store.get(SITE, kept[2]!.address)).toBeUndefined()
    expect(lines.filter((line) => line.includes('could not'))).toHaveLength(1)
    expect(lines.join('\n')).not.toContain(dir)
  })

  it('leaves a file it cannot use because it is something else, and runs memory-only', () => {
    const path = join(dir, swarmChunkFile(SALT))
    const other = new DatabaseSync(path)
    other.exec('CREATE TABLE chunk (note TEXT); INSERT INTO chunk VALUES (\'mine\')')
    other.close()
    const [chunk] = chunks(1)
    const store = database()
    store.put(SITE, chunk!.address, chunk!.bytes)
    expect(store.get(SITE, chunk!.address)).toBeUndefined()
    store.close()
    const check = new DatabaseSync(path)
    expect((check.prepare('SELECT note FROM chunk').get() as { note: string }).note).toBe('mine')
    check.close()
    expect(lines.filter((line) => line.includes('could not be opened'))).toHaveLength(1)
  })

  it('creates the directory when it is missing', () => {
    const [chunk] = chunks(1)
    const store = database({ dir: join(dir, 'profile', 'verifier') })
    store.put(SITE, chunk!.address, chunk!.bytes)
    store.close()
    expect(readdirSync(join(dir, 'profile', 'verifier'))).toContain(swarmChunkFile(SALT))
  })

  it('writes 64 chunks in one go and the rest after 250 ms, never one commit each', () => {
    vi.useFakeTimers()
    const kept = chunks(70)
    const store = database()
    store.put(SITE, kept[0]!.address, kept[0]!.bytes)
    const reader = new DatabaseSync(join(dir, swarmChunkFile(SALT)))
    const count = (): number => (reader.prepare('SELECT count(*) AS n FROM chunk').get() as { n: number }).n
    expect(count()).toBe(0)
    for (const chunk of kept.slice(1, 63)) store.put(SITE, chunk.address, chunk.bytes)
    expect(count()).toBe(0)
    store.put(SITE, kept[63]!.address, kept[63]!.bytes)
    expect(count()).toBe(64)
    for (const chunk of kept.slice(64)) store.put(SITE, chunk.address, chunk.bytes)
    expect(count()).toBe(64)
    vi.advanceTimersByTime(249)
    expect(count()).toBe(64)
    vi.advanceTimersByTime(2)
    expect(count()).toBe(70)
    reader.close()
  })

  it('logs a failed write once, never throws from it, and writes again when the file is free', () => {
    const kept = chunks(3)
    const store = database()
    store.put(SITE, kept[0]!.address, kept[0]!.bytes)
    store.flush()
    const blocker = new DatabaseSync(join(dir, swarmChunkFile(SALT)))
    blocker.exec('BEGIN IMMEDIATE')
    store.put(SITE, kept[1]!.address, kept[1]!.bytes)
    expect(() => { store.flush() }).not.toThrow()
    store.put(SITE, kept[2]!.address, kept[2]!.bytes)
    expect(() => { store.flush() }).not.toThrow()
    expect(lines.filter((line) => line.includes('could not write'))).toHaveLength(1)
    expect(lines.join('\n')).not.toContain(kept[1]!.address)
    blocker.exec('ROLLBACK')
    blocker.close()
    store.put(SITE, kept[1]!.address, kept[1]!.bytes)
    store.flush()
    expect(store.get(SITE, kept[1]!.address)).toEqual(kept[1]!.bytes)
  })

  it('uses pages big enough to hold several chunks each, and reads the size it keeps from the file', () => {
    const kept = chunks(5)
    const store = database()
    for (const chunk of kept) store.put(SITE, chunk.address, chunk.bytes)
    store.close()
    const raw = new DatabaseSync(join(dir, swarmChunkFile(SALT)))
    expect((raw.prepare('PRAGMA page_size').get() as { page_size: number }).page_size).toBe(32768)
    raw.close()
    lines.length = 0
    const again = database()
    again.get(SITE, kept[0]!.address)
    expect(lines).toContain(`swarm: the chunk store opened with ${String(5 * CHUNK)} bytes kept`)
  })

  it('opens nothing until it is used', () => {
    database()
    mkdirSync(join(dir, 'untouched'))
    expect(readdirSync(dir)).toEqual(['untouched'])
  })
})
