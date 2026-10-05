import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SCORE_PROVIDER } from '../schema.js'
import { SettingsStore } from '../settings-store.js'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orivon-settings-'))
  file = join(dir, 'nested', 'settings.json')
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

async function onDisk (): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'))
}

describe('SettingsStore', () => {
  it('answers a default for a setting nobody has touched, with no file at all', async () => {
    const store = new SettingsStore(file)
    await store.load()

    expect(store.get('appearance.theme')).toBe('system')
    expect(store.isDefault('appearance.theme')).toBe(true)
    expect(store.snapshot().changed).toEqual([])
  })

  it('keeps a provider a person cleared, and gives the official one to a profile that never chose', async () => {
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(file, JSON.stringify({ version: 1, values: { 'web3.scoreProvider': '' } }))
    const cleared = new SettingsStore(file)
    await cleared.load()
    expect(cleared.get('web3.scoreProvider')).toBe('')

    const untouched = new SettingsStore(join(dir, 'nested', 'none.json'))
    await untouched.load()
    expect(untouched.get('web3.scoreProvider')).toBe(DEFAULT_SCORE_PROVIDER)
  })

  it('remembers a choice across a restart, and writes only what differs from the default', async () => {
    const store = new SettingsStore(file)
    await store.load()
    expect(store.set('appearance.theme', 'dark')).toEqual({ ok: true })
    expect(store.set('appearance.bookmarksBar', 'auto')).toEqual({ ok: true })
    await store.flush()

    expect(await onDisk()).toEqual({ version: 1, values: { 'appearance.theme': 'dark' } })
    const next = new SettingsStore(file)
    await next.load()
    expect(next.get('appearance.theme')).toBe('dark')
    expect(next.snapshot().changed).toEqual(['appearance.theme'])
  })

  it('refuses an unknown key and an invalid value, and changes nothing', async () => {
    const store = new SettingsStore(file)
    await store.load()
    const listener = vi.fn()
    store.onChange(listener)

    expect(store.set('appearance.nope', 'x')).toEqual({ ok: false, reason: 'unknown-key' })
    expect(store.set('__proto__', 'x')).toEqual({ ok: false, reason: 'unknown-key' })
    expect(store.set('appearance.theme', 'purple')).toEqual({ ok: false, reason: 'invalid-value' })
    expect(store.set('search.customUrl', 'http://insecure.example/?q=%s')).toEqual({ ok: false, reason: 'invalid-value' })

    expect(store.get('appearance.theme')).toBe('system')
    expect(listener).not.toHaveBeenCalled()
  })

  it('tells listeners about a change, once, and not about setting what is already set', async () => {
    const store = new SettingsStore(file)
    await store.load()
    const listener = vi.fn()
    store.onChange(listener)

    store.set('appearance.theme', 'dark')
    store.set('appearance.theme', 'dark')

    expect(listener).toHaveBeenCalledExactlyOnceWith({ key: 'appearance.theme', value: 'dark' })
  })

  it('stops telling a listener that has been removed', async () => {
    const store = new SettingsStore(file)
    await store.load()
    const listener = vi.fn()
    const stop = store.onChange(listener)

    stop()
    store.set('appearance.theme', 'dark')

    expect(listener).not.toHaveBeenCalled()
  })

  it('resets one setting and all of them, and tells listeners each time', async () => {
    const store = new SettingsStore(file)
    await store.load()
    store.set('appearance.theme', 'dark')
    store.set('tabs.lastTabClosed', 'newTab')
    const listener = vi.fn()
    store.onChange(listener)

    expect(store.reset('appearance.theme')).toEqual({ ok: true })
    expect(store.get('appearance.theme')).toBe('system')
    store.resetAll()

    expect(store.snapshot().changed).toEqual([])
    expect(listener.mock.calls.map((call) => (call[0] as { key: string }).key)).toEqual(['appearance.theme', 'tabs.lastTabClosed'])
    expect(store.reset('nope')).toEqual({ ok: false, reason: 'unknown-key' })
    await store.flush()
    expect(await onDisk()).toEqual({ version: 1, values: {} })
  })

  it('ignores an entry the schema would refuse, keeps the rest, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(file, JSON.stringify({
      version: 1,
      values: { 'appearance.theme': 'dark', 'appearance.bookmarksBar': 'sideways', 'made.up': 1, 'tabs.lastTabClosed': 7 }
    }))
    const store = new SettingsStore(file)
    await store.load()

    expect(store.get('appearance.theme')).toBe('dark')
    expect(store.get('appearance.bookmarksBar')).toBe('auto')
    expect(store.get('tabs.lastTabClosed')).toBe('closeWindow')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('3 setting(s)'))
  })

  it.each([
    ['not json at all'],
    ['[]'],
    ['null'],
    [JSON.stringify({ version: 2, values: { 'appearance.theme': 'dark' } })],
    [JSON.stringify({ version: 1, values: 'dark' })]
  ])('starts from the defaults for a file that is %s', async (content) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(file, content)
    const store = new SettingsStore(file)

    await expect(store.load()).resolves.toBeUndefined()

    expect(store.snapshot().changed).toEqual([])
  })

  it('reads the file once, however many callers load', async () => {
    const store = new SettingsStore(file)
    await store.load()
    store.set('appearance.theme', 'dark')

    await store.load()

    expect(store.get('appearance.theme')).toBe('dark')
  })

  it('snapshots every setting\'s effective value', async () => {
    const store = new SettingsStore(file)
    await store.load()
    store.set('search.engine', 'brave')

    const { values, changed } = store.snapshot()

    expect(values['search.engine']).toBe('brave')
    expect(values['appearance.theme']).toBe('system')
    expect(changed).toEqual(['search.engine'])
  })
})
