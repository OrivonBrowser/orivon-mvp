import { describe, expect, it, vi } from 'vitest'
import { CHROME_ACTIONS, runChromeAction } from '../../shell/chrome-actions.js'
import { createOmniboxOverlay } from '../omnibox-overlay.js'
import type { WindowContext } from '../../shell/window-context.js'
import { SHELL_EVENT_CHANNEL } from '../../channels.js'

interface FakeTab { id: string, url: string, displayUrl: string, title: string, favicon: null, isNewTab: boolean }

const tab = (id: string, url: string, title: string, isNewTab = false): FakeTab => ({ id, url, displayUrl: url, title, favicon: null, isNewTab })

function fakeWindow (tabs: FakeTab[], activeTabId: string | null) {
  const overlays = { open: false, show: vi.fn(() => { overlays.open = true }), close: vi.fn(() => { overlays.open = false }), send: vi.fn(), isOpen: () => overlays.open }
  const sent: unknown[] = []
  const manager = {
    getState: () => ({ tabs, activeTabId }),
    ids: () => tabs.map((entry) => entry.id),
    navigate: vi.fn(), createTab: vi.fn(), openInternal: vi.fn(), activateTab: vi.fn(), closeTab: vi.fn(),
    activeWebContents: () => ({ focus: vi.fn() })
  }
  return {
    overlays, sent, manager,
    entry: {
      window: { isDestroyed: () => false, show: vi.fn(), focus: vi.fn() },
      chrome: { webContents: { isDestroyed: () => false, send: (channel: string, payload: unknown) => { sent.push([channel, payload]) } } },
      tabs: manager,
      overlays
    }
  }
}

function setup (options: { history?: Array<{ url: string, title: string }>, bookmarks?: Array<{ url: string, title: string }>, other?: ReturnType<typeof fakeWindow> } = {}) {
  const here = fakeWindow([tab('t1', 'https://here.test/', 'Here'), tab('t2', 'about:blank', 'New tab', true)], 't2')
  const all = [here, ...(options.other === undefined ? [] : [options.other])]
  const markTyped = vi.fn()
  const services = {
    isPrivate: false,
    windows: { all: () => all.map((entry) => entry.entry) },
    history: {
      suggest: (text: string) => (options.history ?? []).filter((page) => page.url.includes(text)).map((page) => ({ ...page, visitCount: 3, typedCount: 0, lastVisit: Date.now() })),
      faviconsFor: () => ({}), markTyped
    },
    bookmarks: { getAll: () => (options.bookmarks ?? []).map((bookmark) => ({ ...bookmark, favicon: null })) },
    searchEngines: { all: () => [] },
    settings: { get: (key: string) => key === 'search.engine' ? 'duckduckgo' : key === 'addressBar.autocomplete' ? true : '' }
  }
  const ctx = { window: here.entry, services } as unknown as WindowContext
  const anchor = { x: 10, y: 20, width: 500, height: 32 }
  return { ctx, here, markTyped, anchor, run: (name: string, payload: unknown) => runChromeAction(name, payload, ctx) }
}

describe('the omnibox chrome actions', () => {
  it('are registered under their names', () => {
    for (const name of ['omnibox.query', 'omnibox.select', 'omnibox.pick', 'omnibox.close']) expect(CHROME_ACTIONS[name]).toBeTypeOf('function')
  })

  describe('omnibox.query', () => {
    it('shows the dropdown under the address bar, then updates it in place', () => {
      const { run, here, anchor } = setup({ history: [{ url: 'https://example.com/', title: 'Example' }] })
      expect(run('omnibox.query', { text: 'exa', typing: false, anchor })).toMatchObject({ count: 2 })
      expect(here.overlays.show).toHaveBeenCalledWith('omnibox', anchor)
      run('omnibox.query', { text: 'exam', typing: false, anchor })
      expect(here.overlays.show).toHaveBeenCalledTimes(1)
      expect(here.overlays.send).toHaveBeenCalledWith('omnibox', expect.objectContaining({ type: 'rows', selected: 0 }))
    })

    it('hides it when nothing can be done with the text', () => {
      const { run, here, anchor } = setup()
      expect(run('omnibox.query', { text: '   ', typing: true, anchor })).toMatchObject({ count: 0 })
      expect(here.overlays.show).not.toHaveBeenCalled()
      expect(here.overlays.close).toHaveBeenCalledWith('omnibox')
    })

    it.each([
      [undefined], [null], ['x'], [{}], [{ text: 3, anchor: { x: 0, y: 0, width: 1, height: 1 } }],
      [{ text: 'a' }], [{ text: 'a', anchor: { x: 0, y: 0, width: 'w', height: 1 } }], [{ text: 'a', anchor: { x: 0, y: 0, width: Number.NaN, height: 1 } }],
      [{ text: 'a'.repeat(2049), anchor: { x: 0, y: 0, width: 1, height: 1 } }]
    ])('ignores the payload %j', (payload) => {
      const { run, here } = setup()
      expect(run('omnibox.query', payload)).toBeUndefined()
      expect(here.overlays.show).not.toHaveBeenCalled()
    })

    it('finishes the text only when it was typed', () => {
      const { run, anchor } = setup({ history: [{ url: 'https://example.com/', title: 'Example' }] })
      expect(run('omnibox.query', { text: 'exa', typing: true, anchor })).toMatchObject({ completion: 'mple.com' })
      expect(run('omnibox.query', { text: 'exa', typing: 'yes', anchor })).toMatchObject({ completion: null })
    })
  })

  describe('omnibox.select', () => {
    it('moves the selection and tells the dropdown', () => {
      const { run, here, anchor } = setup({ history: [{ url: 'https://example.com/', title: 'Example' }] })
      const { seq } = run('omnibox.query', { text: 'exa', typing: false, anchor }) as { seq: number }
      expect(run('omnibox.select', { step: 1, seq })).toEqual({ selected: 1, fill: 'https://example.com/', announce: 'Example, example.com, 2 of 2' })
      expect(here.overlays.send).toHaveBeenLastCalledWith('omnibox', expect.objectContaining({ selected: 1 }))
    })

    it.each([[undefined], [{ step: 0 }], [{ step: 2 }], [{ step: '1' }], [{ step: 1, seq: 'x' }], [{ step: 1, seq: 1.5 }]])('ignores %j', (payload) => {
      const { run, anchor } = setup({ history: [{ url: 'https://example.com/', title: 'Example' }] })
      run('omnibox.query', { text: 'exa', typing: false, anchor })
      expect(run('omnibox.select', payload)).toBeUndefined()
    })

    it('does nothing before anything was queried', () => {
      expect(setup().run('omnibox.select', { step: 1 })).toBeUndefined()
    })
  })

  describe('omnibox.pick', () => {
    const history = [{ url: 'https://example.com/', title: 'Example' }]

    it('goes to a row in this tab, closes the dropdown and tells the bar it is done', () => {
      const { run, here, anchor, markTyped } = setup({ history })
      const { seq } = run('omnibox.query', { text: 'exa', typing: false, anchor }) as { seq: number }
      expect(run('omnibox.pick', { index: 1, disposition: 'current', seq })).toBe(true)
      expect(here.manager.navigate).toHaveBeenCalledWith('t2', 'https://example.com/')
      expect(markTyped).toHaveBeenCalledWith('https://example.com/')
      expect(here.overlays.close).toHaveBeenCalledWith('omnibox')
      expect(here.sent).toEqual([[SHELL_EVENT_CHANNEL, { type: 'module', module: 'address-suggest', payload: { type: 'done' } }]])
    })

    it('submits the first row as it was typed', () => {
      const { run, here, anchor } = setup()
      run('omnibox.query', { text: 'some words', typing: false, anchor })
      run('omnibox.pick', { index: 0, disposition: 'current' })
      expect(here.manager.navigate).toHaveBeenCalledWith('t2', 'some words')
    })

    it('opens a row in a foreground or a background tab', () => {
      const { run, here, anchor } = setup({ history })
      run('omnibox.query', { text: 'exa', typing: false, anchor })
      run('omnibox.pick', { index: 1, disposition: 'tab' })
      expect(here.manager.createTab).toHaveBeenLastCalledWith('https://example.com/', true)
      run('omnibox.query', { text: 'exa', typing: false, anchor })
      run('omnibox.pick', { index: 1, disposition: 'background' })
      expect(here.manager.createTab).toHaveBeenLastCalledWith('https://example.com/', false)
      expect(here.manager.navigate).not.toHaveBeenCalled()
    })

    it('opens one of the shell\'s own pages through its own opener', () => {
      const { run, here, anchor } = setup()
      run('omnibox.query', { text: 'orivon://history', typing: false, anchor })
      run('omnibox.pick', { index: 0, disposition: 'tab' })
      expect(here.manager.openInternal).toHaveBeenCalledWith('history', '/')
      expect(here.manager.createTab).not.toHaveBeenCalled()
    })

    it('offers another browser\'s name for an own page as that page, not as a search', () => {
      const { run, here, anchor } = setup()
      run('omnibox.query', { text: 'chrome://gpu', typing: false, anchor })
      run('omnibox.pick', { index: 0, disposition: 'tab' })
      expect(here.manager.openInternal).toHaveBeenCalledWith('about', '/gpu')
      expect(here.manager.createTab).not.toHaveBeenCalled()
    })

    it.each([
      [{ index: -1, disposition: 'current' }], [{ index: 1.5, disposition: 'current' }], [{ index: 99, disposition: 'current' }], [{ index: '1', disposition: 'current' }],
      [{ index: 1, disposition: 'window' }], [{ index: 1 }], [{ index: 1, disposition: 'current', seq: 'x' }], [undefined], [null]
    ])('ignores the payload %j', (payload) => {
      const { run, here, anchor } = setup({ history })
      run('omnibox.query', { text: 'exa', typing: false, anchor })
      expect(run('omnibox.pick', payload)).toBeFalsy()
      expect(here.manager.navigate).not.toHaveBeenCalled()
      expect(here.manager.createTab).not.toHaveBeenCalled()
    })

    it('refuses a choice from a list that has been replaced', () => {
      const { run, here, anchor } = setup({ history })
      const { seq } = run('omnibox.query', { text: 'exa', typing: false, anchor }) as { seq: number }
      run('omnibox.query', { text: 'exam', typing: false, anchor })
      expect(run('omnibox.pick', { index: 1, disposition: 'current', seq })).toBe(false)
      expect(here.manager.navigate).not.toHaveBeenCalled()
      // Nothing is left to choose from, so the dropdown goes with the refusal.
      expect(here.overlays.close).toHaveBeenCalledWith('omnibox')
    })

    it('can be made through the overlay by an index alone', () => {
      const { run, here, anchor } = setup({ history })
      run('omnibox.query', { text: 'exa', typing: false, anchor })
      run('omnibox.pick', { index: 1, disposition: 'current' })
      expect(here.manager.navigate).toHaveBeenCalledTimes(1)
    })
  })

  describe('the dropdown closing on its own', () => {
    it('tells the chrome when main closed it, so it stops believing it is open, and not when the chrome asked', () => {
      const { here } = setup()
      const handler = createOmniboxOverlay({ window: here.entry } as never)
      for (const reason of ['tab-switch', 'navigation', 'layout', 'window-closed'] as const) {
        handler.closed?.(reason)
        expect(here.sent).toEqual([[SHELL_EVENT_CHANNEL, { type: 'module', module: 'address-suggest', payload: { type: 'closed' } }]])
        here.sent.length = 0
      }
      handler.closed?.('request')
      expect(here.sent).toEqual([])
    })
  })

  describe('choosing a tab', () => {
    it('activates it in its own window, brings that window forward, and closes the empty tab the choice was made from', () => {
      const other = fakeWindow([tab('o1', 'https://there.test/', 'There page')], 'o1')
      const { run, here, anchor } = setup({ other })
      run('omnibox.query', { text: 'there', typing: false, anchor })
      expect(run('omnibox.pick', { index: 1, disposition: 'current' })).toBe(true)
      expect(other.manager.activateTab).toHaveBeenCalledWith('o1')
      expect(other.entry.window.show).toHaveBeenCalled()
      expect(other.entry.window.focus).toHaveBeenCalled()
      expect(here.manager.closeTab).toHaveBeenCalledWith('t2')
      expect(here.manager.navigate).not.toHaveBeenCalled()
    })

    it('leaves a tab that has a page in it open', () => {
      const other = fakeWindow([tab('o1', 'https://there.test/', 'There page')], 'o1')
      const { ctx, here, anchor } = setup({ other })
      ;(here.manager as { getState: () => unknown }).getState = () => ({ tabs: [tab('t1', 'https://here.test/', 'Here')], activeTabId: 't1' })
      runChromeAction('omnibox.query', { text: 'there', typing: false, anchor }, ctx)
      runChromeAction('omnibox.pick', { index: 1, disposition: 'current' }, ctx)
      expect(here.manager.closeTab).not.toHaveBeenCalled()
      expect(other.manager.activateTab).toHaveBeenCalled()
    })

    it('does not offer the tab the person is on, or a blank one', () => {
      const { ctx, here, anchor } = setup()
      expect(runChromeAction('omnibox.query', { text: 'here', typing: false, anchor }, ctx)).toMatchObject({ count: 2 })
      ;(here.manager as { getState: () => unknown }).getState = () => ({ tabs: [tab('t1', 'https://here.test/', 'Here'), tab('t2', 'about:blank', 'New tab', true)], activeTabId: 't1' })
      expect(runChromeAction('omnibox.query', { text: 'here', typing: false, anchor }, ctx)).toMatchObject({ count: 1 })
      expect(runChromeAction('omnibox.query', { text: 'new tab', typing: false, anchor }, ctx)).toMatchObject({ count: 1 })
    })
  })

  describe('omnibox.close', () => {
    it('hides the dropdown and forgets the rows', () => {
      const { run, here, anchor } = setup({ history: [{ url: 'https://example.com/', title: 'Example' }] })
      run('omnibox.query', { text: 'exa', typing: false, anchor })
      run('omnibox.close', {})
      expect(here.overlays.close).toHaveBeenCalledWith('omnibox')
      expect(run('omnibox.pick', { index: 1, disposition: 'current' })).toBe(false)
    })

    it('counts what was submitted as typed when it is an address, and only then', () => {
      const { run, markTyped } = setup()
      run('omnibox.close', { typed: 'example.com' })
      expect(markTyped).toHaveBeenCalledWith('https://example.com/')
      markTyped.mockClear()
      run('omnibox.close', { typed: 'some search words' })
      run('omnibox.close', { typed: '? example.com' })
      run('omnibox.close', { typed: 'javascript:alert(1)' })
      run('omnibox.close', { typed: 7 })
      run('omnibox.close', { typed: 'a'.repeat(3000) })
      run('omnibox.close', undefined)
      expect(markTyped).not.toHaveBeenCalled()
    })
  })
})
