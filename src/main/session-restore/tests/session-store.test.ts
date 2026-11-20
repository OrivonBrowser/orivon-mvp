import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NullSessionStore, SessionStore, TITLE_WRITE_DELAY_MS } from '../session-store.js'
import type { SavedWindow } from '../session-types.js'

let dir: string
let file: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orivon-session-store-'))
  file = join(dir, 'session.json')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const saved = (url: string): SavedWindow => ({ bounds: { x: 0, y: 0, width: 800, height: 600 }, maximized: false, active: 0, tabs: [{ url, title: 'T', pinned: false }] })

describe('the session store', () => {
  it('writes what its source says, as an unfinished session, and says so when it ends in an orderly way', async () => {
    const store = new SessionStore(file)
    await store.load()
    store.attach(() => [saved('https://a.example/')])
    store.changed()
    await store.flush()
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1, clean: false, windows: [{ tabs: [{ url: 'https://a.example/' }] }] })

    store.finish()
    await store.flush()
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ clean: true })
  })

  it('asks its source when it writes, not when it is told of a change', async () => {
    const store = new SessionStore(file)
    await store.load()
    let url = 'https://a.example/'
    store.attach(() => [saved(url)])
    store.changed()
    url = 'https://b.example/'
    await store.flush()
    expect(JSON.parse(await readFile(file, 'utf8')).windows[0].tabs[0].url).toBe('https://b.example/')
  })

  it('batches a burst of changes into one write', async () => {
    const store = new SessionStore(file)
    await store.load()
    let reads = 0
    store.attach(() => { reads++; return [] })
    for (let n = 0; n < 50; n++) store.changed()
    await store.flush()
    expect(reads).toBe(1)
  })

  it('writes a change of titles alone only after its delay, and folds it into a sooner change', async () => {
    const store = new SessionStore(file)
    await store.load()
    let reads = 0
    store.attach(() => { reads++; return [] })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      for (let n = 0; n < 20; n++) store.titlesChanged()
      vi.advanceTimersByTime(TITLE_WRITE_DELAY_MS - 1)
      expect(existsSync(file)).toBe(false)
      store.changed()
      vi.advanceTimersByTime(TITLE_WRITE_DELAY_MS)
    } finally {
      vi.useRealTimers()
    }
    await store.flush()
    expect(reads).toBe(1)
    expect(existsSync(file)).toBe(true)
  })

  it('keeps writing the windows a crashed run left behind until the session ends in an orderly way', async () => {
    const store = new SessionStore(file)
    await store.load()
    store.attach(() => [saved('https://open.example/')])
    store.carry(() => [saved('https://crashed.example/')])
    store.changed()
    await store.flush()
    const urls = (): Promise<string[]> => readFile(file, 'utf8').then((text) => (JSON.parse(text) as { windows: SavedWindow[] }).windows.map((window) => window.tabs[0]?.url ?? ''))
    expect(await urls()).toEqual(['https://open.example/', 'https://crashed.example/'])

    store.finish()
    await store.flush()
    expect(await urls()).toEqual(['https://open.example/'])
  })

  it('writes nothing until something is attached', async () => {
    const store = new SessionStore(file)
    await store.load()
    store.changed()
    await store.flush()
    expect(existsSync(file)).toBe(false)
  })

  it('keeps the session it found at start however much is written afterwards', async () => {
    await writeFile(file, JSON.stringify({ version: 1, clean: false, windows: [saved('https://old.example/')] }))
    const store = new SessionStore(file)
    await store.load()
    store.attach(() => [saved('https://new.example/')])
    store.changed()
    await store.flush()
    expect(store.previous()?.windows[0]?.tabs[0]?.url).toBe('https://old.example/')
    expect(store.previous()?.clean).toBe(false)
    expect(JSON.parse(await readFile(file, 'utf8')).windows[0].tabs[0].url).toBe('https://new.example/')
  })

  it('finds no session in a missing, unreadable or foreign file', async () => {
    expect((await loadedFrom(file)).previous()).toBeNull()
    await writeFile(file, 'garbage')
    expect((await loadedFrom(file)).previous()).toBeNull()
    await writeFile(file, JSON.stringify({ version: 9, windows: [] }))
    expect((await loadedFrom(file)).previous()).toBeNull()
  })
})

async function loadedFrom (path: string): Promise<SessionStore> {
  const store = new SessionStore(path)
  await store.load()
  return store
}

describe('a held session store', () => {
  const urls = async (): Promise<string[]> => (JSON.parse(await readFile(file, 'utf8')) as { windows: SavedWindow[] }).windows.map((window) => window.tabs[0]?.url ?? '')

  it('writes nothing while held, whatever changes, and keeps the file it found', async () => {
    await writeFile(file, JSON.stringify({ version: 1, clean: false, windows: [saved('https://old.example/')] }))
    const store = await loadedFrom(file)
    store.attach(() => [saved('https://new.example/')])
    store.hold()
    store.changed()
    await store.flush()
    expect(await urls()).toEqual(['https://old.example/'])
    expect(JSON.parse(await readFile(file, 'utf8')).clean).toBe(false)
  })

  it('records no orderly end while held: finish writes nothing, so the next start finds the last run as it was', async () => {
    await writeFile(file, JSON.stringify({ version: 1, clean: false, windows: [saved('https://old.example/')] }))
    const store = await loadedFrom(file)
    store.attach(() => [])
    store.hold()
    store.finish()
    await store.flush()
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ clean: false, windows: [{ tabs: [{ url: 'https://old.example/' }] }] })
  })

  it('keeps an orderly end that came while held from being written once it is released', async () => {
    await writeFile(file, JSON.stringify({ version: 1, clean: false, windows: [saved('https://old.example/')] }))
    const store = await loadedFrom(file)
    store.attach(() => [saved('https://new.example/')])
    const release = store.hold()
    store.finish()
    release()
    await store.flush()
    expect(JSON.parse(await readFile(file, 'utf8')).clean).toBe(false)
  })

  it('writes what the windows are by the time it is released, with no further change', async () => {
    await writeFile(file, JSON.stringify({ version: 1, clean: false, windows: [saved('https://old.example/')] }))
    const store = await loadedFrom(file)
    let url = 'https://first.example/'
    store.attach(() => [saved(url)])
    const release = store.hold()
    store.changed()
    await store.flush()
    url = 'https://second.example/'
    release()
    await store.flush()
    expect(await urls()).toEqual(['https://second.example/'])
  })

  it('stays held until every hold is released, and a release answers once', async () => {
    await writeFile(file, JSON.stringify({ version: 1, clean: false, windows: [saved('https://old.example/')] }))
    const store = await loadedFrom(file)
    store.attach(() => [saved('https://new.example/')])
    const one = store.hold()
    const two = store.hold()
    one()
    one()
    store.changed()
    await store.flush()
    expect(await urls()).toEqual(['https://old.example/'])
    two()
    await store.flush()
    expect(await urls()).toEqual(['https://new.example/'])
  })

  it('writes as before once released, an orderly end included', async () => {
    const store = await loadedFrom(file)
    store.attach(() => [saved('https://a.example/')])
    const release = store.hold()
    release()
    store.finish()
    await store.flush()
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ clean: true, windows: [{ tabs: [{ url: 'https://a.example/' }] }] })
  })
})

describe('the null session store', () => {
  it('writes nothing and remembers nothing', async () => {
    await writeFile(file, JSON.stringify({ version: 1, clean: true, windows: [saved('https://old.example/')] }))
    const store = new NullSessionStore()
    await store.load()
    store.attach()
    store.changed()
    store.hold()()
    store.finish()
    await store.flush()
    expect(store.previous()).toBeNull()
    expect(JSON.parse(await readFile(file, 'utf8')).windows[0].tabs[0].url).toBe('https://old.example/')
  })
})
