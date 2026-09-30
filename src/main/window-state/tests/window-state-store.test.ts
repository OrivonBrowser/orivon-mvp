import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileWindowStateStore, NullWindowStateStore, parseSaved } from '../window-state-store.js'

let dir: string
let file: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orivon-window-state-'))
  file = join(dir, 'window-state.json')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const place = { bounds: { x: 10, y: 20, width: 900, height: 620 }, maximized: false }

async function loaded (): Promise<FileWindowStateStore> {
  const store = new FileWindowStateStore(file)
  await store.load()
  return store
}

describe('the window state store', () => {
  it('has nothing saved before the first window is used', async () => {
    expect((await loaded()).get()).toBeNull()
  })

  it('writes the place out and reads it back', async () => {
    const store = await loaded()
    store.set(place)
    await store.flush()
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, ...place })
    expect((await loaded()).get()).toEqual(place)
  })

  it('writes nothing when the place has not changed', async () => {
    const store = await loaded()
    store.set(place)
    await store.flush()
    await rm(file)
    store.set({ bounds: { ...place.bounds }, maximized: false })
    await store.flush()
    await expect(readFile(file)).rejects.toThrow()
  })

  it('opens with nothing saved from a corrupt file', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writeFile(file, '{ not json')
    expect((await loaded()).get()).toBeNull()
  })

  it('refuses a file of another version, or with numbers out of range', async () => {
    await writeFile(file, JSON.stringify({ version: 2, ...place }))
    expect((await loaded()).get()).toBeNull()
    await writeFile(file, JSON.stringify({ version: 1, bounds: { x: 1, y: 2, width: -5, height: 600 }, maximized: false }))
    expect((await loaded()).get()).toBeNull()
    await writeFile(file, JSON.stringify({ version: 1, bounds: { x: '1', y: 2, width: 500, height: 600 }, maximized: false }))
    expect((await loaded()).get()).toBeNull()
    await writeFile(file, JSON.stringify({ version: 1, bounds: place.bounds, maximized: 'yes' }))
    expect((await loaded()).get()).toBeNull()
  })

  it('does not keep a place with a non-finite number', async () => {
    const store = await loaded()
    store.set({ bounds: { x: Number.NaN, y: 0, width: 900, height: 620 }, maximized: false })
    expect(store.get()).toBeNull()
  })
})

describe('parseSaved', () => {
  it('keeps only the four numbers and the flag', () => {
    expect(parseSaved({ version: 1, bounds: { ...place.bounds, extra: 1 }, maximized: true, more: 'x' })).toEqual({ bounds: place.bounds, maximized: true })
  })
})

describe('the null window state store', () => {
  it('remembers nothing and writes nothing', async () => {
    const store = new NullWindowStateStore()
    await store.load()
    store.set()
    await store.flush()
    expect(store.get()).toBeNull()
  })
})
