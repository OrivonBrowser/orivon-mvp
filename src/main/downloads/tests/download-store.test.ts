import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JsonDownloadStore, MAX_ENTRIES, MemoryDownloadStore, parseEntries } from '../download-store.js'
import type { DownloadEntry } from '../download-types.js'

let dir: string
let file: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orivon-downloads-store-'))
  file = join(dir, 'downloads.json')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const entry = (id: string, over: Partial<DownloadEntry> = {}): DownloadEntry => ({
  id, url: 'https://a.example/f.bin', referrer: '', fileName: 'f.bin', savePath: '/d/f.bin', mime: 'application/octet-stream',
  total: 10, received: 10, state: 'completed', startedAt: 1, endedAt: 2, danger: false, ...over
})

describe('the downloads file', () => {
  it('writes the list and reads it back, without the fields that are only true for a moment', async () => {
    const store = new JsonDownloadStore(file)
    store.write([entry('a', { speed: 5, missing: true }), entry('b', { state: 'interrupted', reason: 'network' })])
    await store.flush()
    const raw = JSON.parse(await readFile(file, 'utf8')) as { version: number, entries: Array<Record<string, unknown>> }
    expect(raw.version).toBe(1)
    expect(raw.entries[0]).not.toHaveProperty('speed')
    expect(raw.entries[0]).not.toHaveProperty('missing')
    expect(new JsonDownloadStore(file).read()).toEqual([entry('a'), entry('b', { state: 'interrupted', reason: 'network' })])
  })

  it('reads an empty list from a file that is not there', () => {
    expect(new JsonDownloadStore(file).read()).toEqual([])
  })

  it('reads an empty list from a corrupt file, and from one of another version', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writeFile(file, '{ not json')
    expect(new JsonDownloadStore(file).read()).toEqual([])
    await writeFile(file, JSON.stringify({ version: 2, entries: [entry('a')] }))
    expect(new JsonDownloadStore(file).read()).toEqual([])
    warn.mockRestore()
  })

  it('drops an entry it cannot hold and a repeated id', () => {
    const parsed = parseEntries({ version: 1, entries: [entry('a'), { id: 'b' }, null, entry('a', { fileName: 'other' }), entry('c', { state: 'lost' as never }), entry('d', { total: -1 })] })
    expect(parsed.map((item) => item.id)).toEqual(['a'])
  })

  it('keeps at most as many entries as its limit', () => {
    const many = Array.from({ length: MAX_ENTRIES + 5 }, (_, index) => entry(`e${String(index)}`))
    expect(parseEntries({ version: 1, entries: many })).toHaveLength(MAX_ENTRIES)
  })
})

describe('a held download', () => {
  it('is written and read back as held, and the flag is not invented for an ordinary entry', async () => {
    const store = new JsonDownloadStore(file)
    store.write([entry('h', { state: 'held', held: true, danger: true }), entry('p')])
    await store.flush()
    const [held, plain] = new JsonDownloadStore(file).read()
    expect(held).toMatchObject({ id: 'h', state: 'held', held: true })
    expect(plain).not.toHaveProperty('held')
  })
})

describe('the memory store', () => {
  it('writes nothing to disk and reads nothing back', async () => {
    const store = new MemoryDownloadStore()
    store.write()
    await store.flush()
    expect(store.read()).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })
})
