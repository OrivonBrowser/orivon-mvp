import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_SITES, ZoomStore } from '../zoom-store.js'

let dir: string
let file: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orivon-zoom-store-'))
  file = join(dir, 'zoom.json')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function loaded (): Promise<ZoomStore> {
  const store = new ZoomStore(file)
  await store.load()
  return store
}

describe('the zoom store', () => {
  it('remembers a level per origin and writes it out', async () => {
    const store = await loaded()
    store.set('https://a.example', 150)
    await store.flush()
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, levels: { 'https://a.example': 150 } })

    const reopened = await loaded()
    expect(reopened.get('https://a.example')).toBe(150)
  })

  it('refuses a level or an origin it cannot hold', async () => {
    const store = await loaded()
    store.set('https://a.example', 24)
    store.set('https://a.example', 125.5)
    store.set('not an origin', 150)
    store.set('https://a.example/with/a/path', 150)
    expect(store.size).toBe(0)
  })

  it('tells listeners which origin changed, and removes a choice', async () => {
    const store = await loaded()
    const heard = vi.fn()
    const stop = store.onChange(heard)
    store.set('https://a.example', 150)
    store.remove('https://a.example')
    store.remove('https://a.example')
    store.set('https://b.example', 90)
    store.clear()
    stop()
    store.set('https://c.example', 90)
    expect(heard.mock.calls).toEqual([['https://a.example'], ['https://a.example'], ['https://b.example'], [null]])
  })

  it('drops what a hand-edited or corrupt file holds that is not a valid entry', async () => {
    await writeFile(file, JSON.stringify({ version: 1, levels: { 'https://ok.example': 200, 'https://bad.example': 9000, nonsense: 100, 'https://x.example/path': 100, 'https://s.example': '150' } }))
    const store = await loaded()
    expect(store.size).toBe(1)
    expect(store.get('https://ok.example')).toBe(200)

    await writeFile(file, '{not json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await loaded()).size).toBe(0)
    warn.mockRestore()
    await writeFile(file, JSON.stringify({ version: 2, levels: { 'https://ok.example': 200 } }))
    expect((await loaded()).size).toBe(0)
  })

  it('keeps the newest choices when it holds too many', async () => {
    const store = await loaded()
    for (let n = 0; n < MAX_SITES + 5; n += 1) store.set(`https://site${String(n)}.example`, 150)
    expect(store.size).toBe(MAX_SITES)
    expect(store.get('https://site0.example')).toBeUndefined()
    expect(store.get(`https://site${String(MAX_SITES + 4)}.example`)).toBe(150)
  })
})
