import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_NYM_PRIVACY, NYM_PRIVACY_LEVELS } from '../../../protocols/nym-tunnel/protocol.js'
import { DEFAULT_SCORE_PROVIDER, describeSettings } from '../schema.js'
import { readSettingBeforeReady } from '../settings-file.js'
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

    expect(await onDisk()).toEqual({ version: 2, values: { 'appearance.theme': 'dark' } })
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
    expect(await onDisk()).toEqual({ version: 2, values: {} })
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
    [JSON.stringify({ version: 3, values: { 'appearance.theme': 'dark' } })],
    [JSON.stringify({ version: 1, values: 'dark' })]
  ])('starts from the defaults, with the tunnel held on for the whole browser, for a file that is %s', async (content) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(file, content)
    const store = new SettingsStore(file)

    await expect(store.load()).resolves.toBeUndefined()

    expect(store.snapshot().changed).toEqual(['network.tunnel.everywhere'])
    expect(store.get('appearance.theme')).toBe('system')
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

  it('gives the Global Privacy Control signal to a profile that never chose, and keeps an off that was chosen', async () => {
    const untouched = new SettingsStore(join(dir, 'nested', 'none.json'))
    await untouched.load()
    expect(untouched.get('privacy.globalPrivacyControl')).toBe(true)
    expect(untouched.isDefault('privacy.globalPrivacyControl')).toBe(true)

    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(file, JSON.stringify({ version: 1, values: { 'privacy.globalPrivacyControl': false } }))
    const off = new SettingsStore(file)
    await off.load()
    expect(off.get('privacy.globalPrivacyControl')).toBe(false)
    expect(off.snapshot().changed).toEqual(['privacy.globalPrivacyControl'])

    await writeFile(file, JSON.stringify({ version: 1, values: { 'privacy.globalPrivacyControl': true } }))
    const on = new SettingsStore(file)
    await on.load()
    expect(on.get('privacy.globalPrivacyControl')).toBe(true)
    expect(on.isDefault('privacy.globalPrivacyControl')).toBe(true)
  })

  it('remembers the values the file gave, whatever is changed afterwards', async () => {
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(file, JSON.stringify({ version: 1, values: { 'privacy.globalPrivacyControl': false } }))
    const store = new SettingsStore(file)
    await store.load()
    store.set('privacy.globalPrivacyControl', true)

    expect(store.get('privacy.globalPrivacyControl')).toBe(true)
    expect(store.valuesAtStart()['privacy.globalPrivacyControl']).toBe(false)
  })
})

describe('where a routed app leaves', () => {
  let dir = ''
  let file = ''
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orivon-settings-kind-'))
    file = join(dir, 'settings.json')
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('is Nym until the person chooses their own address', async () => {
    const store = new SettingsStore(file)
    await store.load()
    expect(store.get('network.route.kind')).toBe('nym')
    expect(store.get('network.route.proxy')).toBe('')
  })

  it('keeps an address saved before the choice existed as the choice of that address', async () => {
    await writeFile(file, JSON.stringify({ version: 1, values: { 'network.route.proxy': '127.0.0.1:9050' } }))
    const store = new SettingsStore(file)
    await store.load()
    expect(store.get('network.route.kind')).toBe('socks5')
    expect(store.get('network.route.proxy')).toBe('127.0.0.1:9050')
  })

  it('leaves a version 1 file with no address on Nym', async () => {
    await writeFile(file, JSON.stringify({ version: 1, values: { 'appearance.theme': 'dark' } }))
    const store = new SettingsStore(file)
    await store.load()
    expect(store.get('network.route.kind')).toBe('nym')
  })

  it('leaves a version 2 file with an address and no choice on Nym: that person chose it', async () => {
    await writeFile(file, JSON.stringify({ version: 2, values: { 'network.route.proxy': '127.0.0.1:9050' } }))
    const store = new SettingsStore(file)
    await store.load()
    expect(store.get('network.route.kind')).toBe('nym')
  })

  it('does not turn a person who chose Nym back to the address on the next start', async () => {
    await writeFile(file, JSON.stringify({ version: 1, values: { 'network.route.proxy': '127.0.0.1:9050' } }))
    const first = new SettingsStore(file)
    await first.load()
    first.set('network.route.kind', 'nym')
    await first.flush()
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 2, values: { 'network.route.proxy': '127.0.0.1:9050' } })
    const second = new SettingsStore(file)
    await second.load()
    expect(second.get('network.route.kind')).toBe('nym')
    expect(readSettingBeforeReady(file, 'network.route.kind')).toBe('nym')
  })

  it('reads the choice before the settings store does, for a version 1 file too', async () => {
    await writeFile(file, JSON.stringify({ version: 1, values: { 'network.route.proxy': '127.0.0.1:9050' } }))
    expect(readSettingBeforeReady(file, 'network.route.kind')).toBe('socks5')
  })

  it('refuses a kind that is neither', async () => {
    const store = new SettingsStore(file)
    await store.load()
    expect(store.set('network.route.kind', 'tor')).toEqual({ ok: false, reason: 'invalid-value' })
  })
})

describe('the Nym privacy level', () => {
  let dir = ''
  let file = ''
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orivon-settings-privacy-'))
    file = join(dir, 'settings.json')
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('is balanced until the person chooses, and a file written before the setting existed keeps it so', async () => {
    await writeFile(file, JSON.stringify({ version: 2, values: { 'network.route.kind': 'nym' } }))
    const store = new SettingsStore(file)
    await store.load()
    expect(store.get('network.nym.privacy')).toBe('balanced')
    expect(readSettingBeforeReady(file, 'network.nym.privacy')).toBe('balanced')
  })

  it('keeps strongest across a restart, and reads it before the store does', async () => {
    const first = new SettingsStore(file)
    await first.load()
    expect(first.set('network.nym.privacy', 'strongest')).toMatchObject({ ok: true })
    await first.flush()
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 2, values: { 'network.nym.privacy': 'strongest' } })
    expect(readSettingBeforeReady(file, 'network.nym.privacy')).toBe('strongest')
    const second = new SettingsStore(file)
    await second.load()
    expect(second.get('network.nym.privacy')).toBe('strongest')
  })

  it('refuses a level that is neither, from a call and from a file', async () => {
    const store = new SettingsStore(file)
    await store.load()
    expect(store.set('network.nym.privacy', 'off')).toEqual({ ok: false, reason: 'invalid-value' })
    await writeFile(file, JSON.stringify({ version: 2, values: { 'network.nym.privacy': 'weakest' } }))
    expect(readSettingBeforeReady(file, 'network.nym.privacy')).toBe('balanced')
  })

  it('offers the levels the Nym host knows, in the same words', async () => {
    const described = describeSettings().find((setting) => setting.key === 'network.nym.privacy')
    expect(described).toMatchObject({ kind: 'enum', options: [...NYM_PRIVACY_LEVELS], default: DEFAULT_NYM_PRIVACY })
  })
})

describe('SettingsStore with a settings file that cannot be used', () => {
  it('holds the tunnel on for the whole browser, says so, and keeps a copy of the file', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(file, '{ not json')
    const store = new SettingsStore(file)
    await store.load()

    expect(store.get('network.tunnel.everywhere')).toBe(true)
    expect(store.fileUnreadable()).toBe(true)
    expect(store.get('network.route.kind')).toBe('nym')
    expect(await readFile(`${file}.unreadable`, 'utf8')).toBe('{ not json')
  })

  it('does the same for a file of a version this build does not read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(file, JSON.stringify({ version: 99, values: { 'network.tunnel.everywhere': false } }))
    const store = new SettingsStore(file)
    await store.load()
    expect(store.get('network.tunnel.everywhere')).toBe(true)
    expect(store.fileUnreadable()).toBe(true)
  })

  it('lets the person turn it off, which then stops saying it is held', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(file, '{ not json')
    const store = new SettingsStore(file)
    await store.load()
    store.set('network.tunnel.everywhere', false)
    expect(store.get('network.tunnel.everywhere')).toBe(false)
    expect(store.fileUnreadable()).toBe(false)
  })

  it('leaves a missing file and a good one alone', async () => {
    const missing = new SettingsStore(file)
    await missing.load()
    expect(missing.get('network.tunnel.everywhere')).toBe(false)
    expect(missing.fileUnreadable()).toBe(false)
  })
})
