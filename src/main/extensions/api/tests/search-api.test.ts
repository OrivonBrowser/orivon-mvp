import { describe, expect, it, vi } from 'vitest'
import { BOTH_ERROR, installSearch, parseQuery, searchApi } from '../search-api.js'
import { fakeContext } from './api-fixtures.js'

const ENGINE_URL = (text: string): string => `https://duckduckgo.com/?q=${encodeURIComponent(text).replace(/%20/g, '+')}`

function setup (opts: { appTab?: boolean, internal?: boolean, noWindow?: boolean } = {}) {
  const tabs = { createTab: vi.fn(), navigate: vi.fn() }
  const window = { tabs }
  const contents = { getURL: () => (opts.appTab === true ? 'https://app.example/x' : 'https://page.test/') }
  const openWindow = vi.fn()
  const shell = {
    settings: { get: (key: string) => (key === 'search.engine' ? 'duckduckgo' : '') },
    windows: { focused: () => (opts.noWindow === true ? undefined : window) },
    commands: { openWindow },
    internalPages: { pageOf: () => (opts.internal === true ? 'settings' : undefined) }
  }
  const found = { contents, window, id: 't1' }
  const fake = fakeContext(shell, { tab: ((id: unknown) => (id === 42 ? found : undefined)) as never, activeTab: (() => found) as never })
  installSearch(fake.ctx)
  return { tabs, openWindow, ...fake }
}

describe('search.query', () => {
  it('is gated on the search permission', () => {
    expect(searchApi).toMatchObject({ name: 'search', permission: 'search' })
  })

  it('searches in the current tab by default, with the engine\'s own URL', async () => {
    const s = setup()
    await s.call('search.query', { text: 'orivon browser' })
    expect(s.tabs.navigate).toHaveBeenCalledWith('t1', ENGINE_URL('orivon browser'))
    expect(s.tabs.createTab).not.toHaveBeenCalled()
  })

  it('opens a new tab or a new window on request', async () => {
    const s = setup()
    await s.call('search.query', { text: 'a&b=c', disposition: 'NEW_TAB' })
    expect(s.tabs.createTab).toHaveBeenCalledWith(ENGINE_URL('a&b=c'))
    await s.call('search.query', { text: 'x', disposition: 'NEW_WINDOW' })
    expect(s.openWindow).toHaveBeenCalledTimes(1)
    const options = s.openWindow.mock.calls[0]?.[0] as { first: (tabs: { createTab: (url: string) => void }) => void }
    const made = vi.fn()
    options.first({ createTab: made })
    expect(made).toHaveBeenCalledWith(ENGINE_URL('x'))
  })

  it('opens a new window when there is none, and a new tab when the current one is an app or an Orivon page', async () => {
    const none = setup({ noWindow: true })
    await none.call('search.query', { text: 'x' })
    expect(none.openWindow).toHaveBeenCalledTimes(1)
    for (const opts of [{ appTab: true }, { internal: true }]) {
      const s = setup(opts)
      await s.call('search.query', { text: 'x' })
      expect(s.tabs.navigate).not.toHaveBeenCalled()
      expect(s.tabs.createTab).toHaveBeenCalledWith(ENGINE_URL('x'))
    }
  })

  it('searches in the tab it is told to, and refuses a tab it cannot use', async () => {
    const s = setup()
    await s.call('search.query', { text: 'x', tabId: 42 })
    expect(s.tabs.navigate).toHaveBeenCalledWith('t1', ENGINE_URL('x'))
    await expect(s.call('search.query', { text: 'x', tabId: 7 })).rejects.toThrow('No tab with id: 7.')
    for (const opts of [{ appTab: true }, { internal: true }]) {
      await expect(setup(opts).call('search.query', { text: 'x', tabId: 42 })).rejects.toThrow('No tab with id: 42.')
    }
  })

  it('searches in the window the call comes from, not the one in front of the person', async () => {
    const own = { tabs: { createTab: vi.fn(), navigate: vi.fn() }, window: { id: 5 } }
    const other = { tabs: { createTab: vi.fn(), navigate: vi.fn() }, window: { id: 6 } }
    const found = { contents: { getURL: () => 'https://page.test/' }, window: own, id: 'own-tab' }
    const shell = {
      settings: { get: (key: string) => (key === 'search.engine' ? 'duckduckgo' : '') },
      windows: { focused: () => other },
      commands: { openWindow: vi.fn() },
      internalPages: { pageOf: () => undefined }
    }
    const activeTab = vi.fn((windowId?: unknown) => (windowId === 5 ? found : undefined))
    const fake = fakeContext(shell, { callerWindow: (() => own) as never, activeTab: activeTab as never })
    installSearch(fake.ctx)
    await fake.call('search.query', { text: 'x' })
    expect(own.tabs.navigate).toHaveBeenCalledWith('own-tab', ENGINE_URL('x'))
    await fake.call('search.query', { text: 'y', disposition: 'NEW_TAB' })
    expect(own.tabs.createTab).toHaveBeenCalledWith(ENGINE_URL('y'))
    expect(other.tabs.navigate).not.toHaveBeenCalled()
    expect(other.tabs.createTab).not.toHaveBeenCalled()
  })

  it('rejects a disposition together with a tab id, with Chrome\'s text', async () => {
    await expect(setup().call('search.query', { text: 'x', tabId: 42, disposition: 'NEW_TAB' })).rejects.toThrow(BOTH_ERROR)
  })
})

describe('parseQuery', () => {
  it('needs a non-empty text of at most 2,000 characters', () => {
    for (const bad of [{}, { text: '' }, { text: '   ' }, { text: 5 }, { text: 'x'.repeat(2001) }, null, 'x', []]) {
      expect(() => parseQuery(bad)).toThrow('Invalid argument')
    }
    expect(parseQuery({ text: 'x'.repeat(2000) }).text).toHaveLength(2000)
  })

  it('knows three dispositions and integer tab ids', () => {
    expect(() => parseQuery({ text: 'x', disposition: 'BACKGROUND' })).toThrow('Invalid argument')
    expect(() => parseQuery({ text: 'x', tabId: 1.5 })).toThrow('Invalid argument')
    expect(() => parseQuery({ text: 'x', tabId: '1' })).toThrow('Invalid argument')
    expect(parseQuery({ text: 'x', disposition: 'NEW_TAB' }).disposition).toBe('NEW_TAB')
  })
})
