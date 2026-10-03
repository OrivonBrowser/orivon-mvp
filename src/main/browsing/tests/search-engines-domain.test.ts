import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { InternalCaller } from '../../pages/internal-ipc.js'
import { SettingsStore } from '../../settings/settings-store.js'
import { SearchEngineStore } from '../search-engine-store.js'
import { searchEnginesDomain } from '../search-engines-domain.js'

let dir: string
let store: SearchEngineStore
let settings: SettingsStore
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orivon-engines-domain-'))
  store = new SearchEngineStore(join(dir, 'search-engines.json'), { newId: (() => { let n = 0; return () => `e-${String(++n)}` })() })
  settings = new SettingsStore(join(dir, 'settings.json'))
  await store.load()
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const caller = { page: 'settings' } as InternalCaller
const call = async (command: unknown, isPrivate = false): Promise<any> => await searchEnginesDomain(store, settings, { isPrivate }).handle(command, caller)
const fx = { name: 'Fixture', keyword: 'fx', template: 'https://fixture.example/search?q=%s' }

describe('searchEnginesDomain', () => {
  it('is for the Settings page only', () => {
    expect(searchEnginesDomain(store, settings, { isPrivate: false }).pages).toEqual(['settings'])
  })

  it('lists the engines, the default with the badge, and whether it offers suggestions', async () => {
    const reply = await call({ type: 'list' })
    expect(reply.engines).toHaveLength(12)
    expect(reply).toMatchObject({ defaultId: 'duckduckgo', defaultName: 'DuckDuckGo', suggestable: true, isPrivate: false })
    settings.set('search.engine', 'brave')
    expect(await call({ type: 'list' })).toMatchObject({ defaultId: 'brave', suggestable: false })
  })

  it('reports a default that is the person\'s own address and none of the engines', async () => {
    settings.set('search.customUrl', 'https://mine.example/?q=%s')
    settings.set('search.engine', 'custom')
    expect(await call({ type: 'list' })).toMatchObject({ defaultId: null, defaultName: '', suggestable: false })
  })

  it('adds, and answers a refusal with the field and the reason', async () => {
    expect(await call({ type: 'add', ...fx })).toEqual({ ok: true })
    expect(await call({ type: 'add', ...fx, name: 'Again' })).toEqual({ ok: false, field: 'keyword', reason: 'used', usedBy: 'Fixture' })
    expect(await call({ type: 'add', ...fx, keyword: 'f', name: '' })).toEqual({ ok: false, field: 'name', reason: 'required' })
    expect(await call({ type: 'add', ...fx, keyword: 'f', template: 'http://x.example/?q=%s' })).toEqual({ ok: false, field: 'template', reason: 'template' })
    expect(await call({ type: 'add', name: 5, keyword: 'f', template: 'https://x.example/?q=%s' })).toMatchObject({ ok: false })
    expect(await call({ type: 'add', ...fx, template: 'x'.repeat(5000) })).toMatchObject({ ok: false })
  })

  it('edits and removes by id, and refuses a built-in', async () => {
    await call({ type: 'add', ...fx })
    const id = (await call({ type: 'list' })).engines.find((engine: { keyword: string }) => engine.keyword === 'fx').id as string
    expect(await call({ type: 'update', id, ...fx, name: 'Renamed' })).toEqual({ ok: true })
    expect((await call({ type: 'list' })).engines.find((engine: { id: string }) => engine.id === id).name).toBe('Renamed')
    expect(await call({ type: 'update', id: 'google', ...fx })).toEqual({ ok: false, reason: 'builtin' })
    expect(await call({ type: 'remove', id: 'google' })).toEqual({ ok: false, reason: 'builtin' })
    expect(await call({ type: 'remove', id })).toEqual({ ok: true })
    expect(await call({ type: 'remove', id })).toEqual({ ok: false, reason: 'not-found' })
    expect(await call({ type: 'remove', id: 7 })).toEqual({ ok: false, reason: 'not-found' })
  })

  it('gives the built-in default back when the engine that was the default is removed, and leaves another default alone', async () => {
    await call({ type: 'add', ...fx })
    const id = store.all().find((engine) => engine.keyword === 'fx')?.id ?? ''
    await call({ type: 'makeDefault', id })
    expect(await call({ type: 'remove', id })).toEqual({ ok: true })
    expect(settings.isDefault('search.engine')).toBe(true)
    expect(settings.isDefault('search.customUrl')).toBe(true)
    expect((await call({ type: 'list' })).defaultId).not.toBeNull()

    await call({ type: 'add', ...fx })
    const other = store.all().find((engine) => engine.keyword === 'fx')?.id ?? ''
    await call({ type: 'makeDefault', id: 'google' })
    await call({ type: 'remove', id: other })
    expect(settings.get('search.engine')).toBe('google')
  })

  it('makes a built-in engine the default by choosing it', async () => {
    expect(await call({ type: 'makeDefault', id: 'google' })).toEqual({ ok: true })
    expect(settings.get('search.engine')).toBe('google')
  })

  it('makes a custom or site engine the default by choosing Custom with its address', async () => {
    await call({ type: 'add', ...fx })
    const id = store.all().find((engine) => engine.keyword === 'fx')?.id ?? ''
    expect(await call({ type: 'makeDefault', id })).toEqual({ ok: true })
    expect(settings.get('search.engine')).toBe('custom')
    expect(settings.get('search.customUrl')).toBe(fx.template)
    expect(await call({ type: 'list' })).toMatchObject({ defaultId: id, suggestable: false })
    await call({ type: 'makeDefault', id: 'seed-wikipedia' })
    expect(settings.get('search.customUrl')).toBe('https://en.wikipedia.org/w/index.php?search=%s')
    expect(await call({ type: 'makeDefault', id: 'nope' })).toEqual({ ok: false, reason: 'not-found' })
  })

  it('moves the default with the engine when its address is edited', async () => {
    await call({ type: 'add', ...fx })
    const id = store.all().find((engine) => engine.keyword === 'fx')?.id ?? ''
    await call({ type: 'makeDefault', id })
    await call({ type: 'update', id, ...fx, template: 'https://fixture.example/find?text=%s' })
    expect(settings.get('search.customUrl')).toBe('https://fixture.example/find?text=%s')
    expect(await call({ type: 'list' })).toMatchObject({ defaultId: id })
  })

  it('leaves the default alone when another engine is edited', async () => {
    await call({ type: 'makeDefault', id: 'google' })
    await call({ type: 'update', id: 'seed-github', name: 'GitHub', keyword: 'gh', template: 'https://github.com/find?q=%s' })
    expect(settings.get('search.engine')).toBe('google')
  })

  it('says a private session cannot change the list', async () => {
    const readOnly = new SearchEngineStore(join(dir, 'ro.json'), { readOnly: true })
    const reply = await searchEnginesDomain(readOnly, settings, { isPrivate: true }).handle({ type: 'add', ...fx }, caller)
    expect(reply).toEqual({ ok: false, reason: 'private' })
  })

  it('answers nothing to a command it does not know, and tells a private window so', async () => {
    expect(await call({ type: 'nope' })).toBeUndefined()
    expect(await call(null)).toBeUndefined()
    expect(await call({ type: 'list' }, true)).toMatchObject({ isPrivate: true })
  })
})
