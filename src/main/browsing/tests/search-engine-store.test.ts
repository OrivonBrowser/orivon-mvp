import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SearchEngineStore } from '../search-engine-store.js'
import { SITE_ENGINE_SEEDS } from '../site-engines.js'

let dir: string
let file: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-engines-')); file = join(dir, 'nested', 'search-engines.json') })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

let counter = 0
const newStore = (options: { readOnly?: boolean } = {}): SearchEngineStore => new SearchEngineStore(file, { ...options, newId: () => `e-${String(++counter)}` })
const draft = { name: 'Docs', keyword: 'docs', template: 'https://docs.example/?q=%s' }
const names = (store: SearchEngineStore): string[] => store.all().map((engine) => engine.name)

describe('SearchEngineStore', () => {
  it('lists the built-in engines, then the starting site engines, with no file', async () => {
    const store = newStore()
    await store.load()
    const all = store.all()
    expect(all.filter((engine) => engine.kind === 'builtin').map((engine) => engine.keyword)).toEqual(['ddg', 'sp', 'brave', 'eco', 'qw', 'mj', 'bing', 'g'])
    expect(all.filter((engine) => engine.kind === 'site').map((engine) => engine.keyword)).toEqual(['w', 'yt', 'gh', 'map'])
  })

  it('adds an engine, refuses a keyword already in use, and keeps the list in the file', async () => {
    const store = newStore()
    await store.load()
    const added = store.add(draft)
    expect(added).toMatchObject({ ok: true, engine: { name: 'Docs', kind: 'custom' } })
    expect(store.add({ ...draft, name: 'Other' })).toEqual({ ok: false, field: 'keyword', reason: 'used', usedBy: 'Docs' })
    expect(store.add({ ...draft, name: 'Wiki', keyword: 'W' })).toMatchObject({ ok: false, reason: 'used', usedBy: 'Wikipedia' })
    expect(store.add({ ...draft, name: 'G', keyword: 'g' })).toMatchObject({ ok: false, reason: 'used', usedBy: 'Google' })
    await store.flush()
    const again = newStore()
    await again.load()
    expect(names(again)).toContain('Docs')
  })

  it('edits an engine, letting it keep its own keyword', async () => {
    const store = newStore()
    await store.load()
    const engine = (store.add(draft) as { engine: { id: string } }).engine
    expect(store.update(engine.id, { ...draft, name: 'Docs site' })).toMatchObject({ ok: true, engine: { name: 'Docs site', keyword: 'docs' } })
    expect(store.update(engine.id, { ...draft, keyword: 'yt' })).toMatchObject({ ok: false, reason: 'used', usedBy: 'YouTube' })
    expect(store.get(engine.id)?.name).toBe('Docs site')
  })

  it('edits a starting site engine and removes one, which stays removed after a reload', async () => {
    const store = newStore()
    await store.load()
    expect(store.update('seed-github', { name: 'GitHub', keyword: 'git', template: 'https://github.com/search?q=%s' })).toMatchObject({ ok: true })
    expect(store.remove('seed-youtube')).toMatchObject({ ok: true })
    await store.flush()
    const again = newStore()
    await again.load()
    expect(again.all().find((engine) => engine.id === 'seed-github')).toMatchObject({ keyword: 'git', kind: 'site' })
    expect(names(again)).not.toContain('YouTube')
    expect(again.all().some((engine) => engine.keyword === 'yt')).toBe(false)
  })

  it('frees the keyword of a removed engine', async () => {
    const store = newStore()
    await store.load()
    store.remove('seed-wikipedia')
    expect(store.add({ ...draft, keyword: 'w' })).toMatchObject({ ok: true })
  })

  it('refuses to edit or remove a built-in engine, or one that is not there', async () => {
    const store = newStore()
    await store.load()
    expect(store.update('google', draft)).toEqual({ ok: false, reason: 'builtin' })
    expect(store.remove('google')).toEqual({ ok: false, reason: 'builtin' })
    expect(store.remove('nope')).toEqual({ ok: false, reason: 'not-found' })
    expect(store.update('nope', draft)).toEqual({ ok: false, reason: 'not-found' })
  })

  it('refuses an invalid template with the field it is in', async () => {
    const store = newStore()
    await store.load()
    expect(store.add({ ...draft, template: 'http://docs.example/?q=%s' })).toEqual({ ok: false, field: 'template', reason: 'template' })
  })

  it('stops at the limit', async () => {
    const store = newStore()
    await store.load()
    let last: unknown
    for (let n = 0; n < 200; n += 1) last = store.add({ name: `E${String(n)}`, keyword: `k${String(n)}`, template: 'https://e.example/?q=%s' })
    expect(last).toEqual({ ok: false, reason: 'limit' })
  })

  it('drops an entry whose template is invalid or whose keyword is taken when it loads', async () => {
    file = join(dir, 'search-engines.json')
    await writeFile(file, JSON.stringify({
      version: 1,
      removedSeeds: [],
      engines: [
        { id: 'e-a', name: 'Good', keyword: 'good', template: 'https://good.example/?q=%s' },
        { id: 'e-b', name: 'Insecure', keyword: 'bad', template: 'http://bad.example/?q=%s' },
        { id: 'e-c', name: 'Script', keyword: 'sc', template: 'javascript:alert(%s)' },
        { id: 'e-d', name: 'Takes g', keyword: 'g', template: 'https://x.example/?q=%s' },
        { id: 'e-e', name: 'Twin', keyword: 'GOOD', template: 'https://twin.example/?q=%s' },
        { id: 'e-f', name: 'Space', keyword: 'a b', template: 'https://space.example/?q=%s' },
        { id: 'google', name: 'Takes an id', keyword: 'zz', template: 'https://zz.example/?q=%s' },
        'junk',
        { id: 5 }
      ]
    }))
    const store = newStore()
    await store.load()
    expect(store.all().filter((engine) => engine.kind !== 'builtin' && !engine.id.startsWith('seed-')).map((engine) => engine.name)).toEqual(['Good'])
  })

  it('gives a new starting engine to a file written before it existed, unless its keyword is taken', async () => {
    file = join(dir, 'search-engines.json')
    await writeFile(file, JSON.stringify({ version: 1, removedSeeds: [], engines: [{ id: 'e-a', name: 'Mine', keyword: 'map', template: 'https://mine.example/?q=%s' }] }))
    const store = newStore()
    await store.load()
    expect(store.all().filter((engine) => engine.kind === 'site').map((engine) => engine.keyword)).toEqual(['w', 'yt', 'gh'])
    expect(SITE_ENGINE_SEEDS).toHaveLength(4)
  })

  it.each(['not json', '{"version":2,"engines":[]}', '[]', '{"version":1}'])('starts from the seeds for a file that says %s', async (text) => {
    file = join(dir, 'search-engines.json')
    await writeFile(file, text)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = newStore()
    await store.load()
    expect(store.all().filter((engine) => engine.kind === 'site')).toHaveLength(4)
    vi.restoreAllMocks()
  })

  it('reads a private session\'s list and refuses every write, leaving no file', async () => {
    file = join(dir, 'search-engines.json')
    await writeFile(file, JSON.stringify({ version: 1, removedSeeds: ['seed-youtube'], engines: [{ id: 'e-a', name: 'Mine', keyword: 'mine', template: 'https://mine.example/?q=%s' }] }))
    const before = await readFile(file, 'utf8')
    const store = newStore({ readOnly: true })
    await store.load()
    expect(names(store)).toContain('Mine')
    expect(store.add(draft)).toEqual({ ok: false, reason: 'private' })
    expect(store.update('e-a', draft)).toEqual({ ok: false, reason: 'private' })
    expect(store.remove('e-a')).toEqual({ ok: false, reason: 'private' })
    await store.flush()
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('tells a listener about every change', async () => {
    const store = newStore()
    await store.load()
    const listener = vi.fn()
    const off = store.onChange(listener)
    store.add(draft)
    store.remove('seed-github')
    off()
    store.remove('seed-youtube')
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
