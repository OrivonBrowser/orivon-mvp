import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverlayHandler, OverlayWindow } from '../../overlays/overlay-types.js'
import { ClosedStack } from '../../session-restore/closed-stack.js'
import { TabLifecycle } from '../../shell/tab-lifecycle.js'
import type { ShellServices } from '../../shell/shell-services.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import { PUSH_INTERVAL_MS, tabSearchOverlay } from '../tab-search-overlay.js'
import type { SearchRow } from '../tab-search-model.js'

interface FakeWindow {
  readonly shell: ShellWindow
  readonly calls: string[]
  readonly focused: { wc: string[] }
  destroyed: boolean
  state: Array<{ id: string, title: string }>
  active: string | null
  push: () => void
  readonly listeners: Set<() => void>
}

function fakeWindow (id: number, tabs: string[], active: string | null = tabs[0] ?? null): FakeWindow {
  const calls: string[] = []
  const listeners = new Set<() => void>()
  const fake: FakeWindow = {
    calls, listeners, destroyed: false, active, focused: { wc: [] },
    state: tabs.map((tab) => ({ id: tab, title: `Title ${tab}` })),
    push: () => { for (const listener of [...listeners]) listener() },
    shell: {
      window: { id, isDestroyed: () => fake.destroyed, show: () => { calls.push('show') }, focus: () => { calls.push('focus') } },
      tabs: {
        getState: () => ({ tabs: fake.state.map((tab) => ({ id: tab.id, title: tab.title, url: `https://${tab.id}.example/`, displayUrl: `https://${tab.id}.example/`, favicon: null, isNewTab: false, pinned: false, audible: false, muted: false })), activeTabId: fake.active }),
        ids: () => fake.state.map((tab) => tab.id),
        activateTab: (tab: string) => { calls.push(`activate ${tab}`); fake.active = tab },
        closeTab: (tab: string) => { calls.push(`close ${tab}`); fake.state = fake.state.filter((other) => other.id !== tab) },
        activeWebContents: () => ({ focus: () => { calls.push('focus page') } }),
        onStateChange: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
        findTabIdByWebContents: (wc: { tab: string }) => fake.state.find((tab) => tab.id === wc.tab)?.id ?? null
      }
    } as unknown as ShellWindow
  }
  return fake
}

interface Rig {
  handler: OverlayHandler
  send: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  reopen: ReturnType<typeof vi.fn>
  closedTabs: ClosedStack
  lifecycle: TabLifecycle
}

function rig (windows: FakeWindow[], mine: FakeWindow): Rig {
  const lifecycle = new TabLifecycle()
  const closedTabs = new ClosedStack()
  const reopen = vi.fn(() => 'opened')
  const services = {
    tabLifecycle: lifecycle,
    closedTabs,
    commands: { reopen },
    windows: {
      all: () => windows.map((entry) => entry.shell),
      findTab: (wc: { tab: string }) => { const owner = windows.find((entry) => entry.state.some((tab) => tab.id === wc.tab)); return owner === undefined ? null : { window: owner.shell, tabId: wc.tab } }
    }
  } as unknown as ShellServices
  const send = vi.fn()
  let handler: OverlayHandler | undefined
  const close = vi.fn(() => { handler?.closed?.('request') })
  const win = { window: mine.shell, services, send, close } as unknown as OverlayWindow
  handler = tabSearchOverlay.attach(win)
  return { handler, send, close, reopen, closedTabs, lifecycle }
}

const showRows = (handler: OverlayHandler): SearchRow[] => (handler.show?.(undefined) as { rows: SearchRow[] }).rows

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('the overlay declaration', () => {
  it('is a 520px popup at the top centre that takes focus, is rebuilt each time, and leaves a tab switch to the list itself', () => {
    expect(tabSearchOverlay).toMatchObject({ name: 'tab-search', placement: { kind: 'area', at: 'top-center', width: 520 }, surface: 'panel', focus: 'take', layer: 'popup', keep: 'fresh', height: { max: 420 } })
    expect(tabSearchOverlay.closeOn).toEqual({ blur: true, tabSwitch: false, navigation: false, layout: true })
  })
})

describe('show', () => {
  it('lists the tabs of every window of the process and what was closed', () => {
    const one = fakeWindow(1, ['a', 'b'])
    const two = fakeWindow(2, ['c'])
    const { handler, closedTabs } = rig([one, two], one)
    closedTabs.push({ kind: 'tab', index: 0, windowKey: 1, tab: { url: 'https://old.example/', title: 'Old', pinned: false } })
    const rows = showRows(handler)
    expect(rows.map((row) => row.kind === 'tab' ? row.id : `closed ${row.title}`).sort()).toEqual(['a', 'b', 'c', 'closed Old'])
    expect(rows.find((row) => row.kind === 'tab' && row.id === 'c')).toMatchObject({ otherWindow: 2 })
  })

  it('skips a window that is already destroyed', () => {
    const one = fakeWindow(1, ['a'])
    const two = fakeWindow(2, ['c'])
    two.destroyed = true
    const { handler } = rig([one, two], one)
    expect(showRows(handler).map((row) => row.kind === 'tab' && row.id)).toEqual(['a'])
  })
})

describe('requests', () => {
  it('activates a tab of this window and closes the list', () => {
    const one = fakeWindow(1, ['a', 'b'])
    const { handler, close } = rig([one], one)
    handler.show?.(undefined)
    handler.request({ type: 'activate', id: 'b' })
    expect(close).toHaveBeenCalledTimes(1)
    expect(one.calls).toEqual(['activate b', 'focus page'])
  })

  it('activates a tab of another window, brings that window forward and gives its page the keys', () => {
    const one = fakeWindow(1, ['a'])
    const two = fakeWindow(2, ['c', 'd'])
    const { handler } = rig([one, two], one)
    handler.show?.(undefined)
    handler.request({ type: 'activate', id: 'd' })
    expect(two.calls).toEqual(['activate d', 'show', 'focus', 'focus page'])
    expect(one.calls).toEqual([])
  })

  it('closes a tab from the list without closing the list, and does not take its replacement for a tab switch', () => {
    const one = fakeWindow(1, ['a', 'b'], 'a')
    const { handler, close, lifecycle } = rig([one], one)
    handler.show?.(undefined)
    one.shell.tabs.closeTab = ((tab: string) => {
      one.calls.push(`close ${tab}`)
      one.state = one.state.filter((other) => other.id !== tab)
      one.active = 'b'
      lifecycle.tabActivated({ tab: 'b' } as never)
    }) as never
    handler.request({ type: 'close', id: 'a' })
    expect(one.calls).toEqual(['close a'])
    expect(close).not.toHaveBeenCalled()
  })

  it('closes a tab of another window', () => {
    const one = fakeWindow(1, ['a'])
    const two = fakeWindow(2, ['c', 'd'])
    const { handler } = rig([one, two], one)
    handler.show?.(undefined)
    handler.request({ type: 'close', id: 'd' })
    expect(two.calls).toEqual(['close d'])
  })

  it('reopens a closed entry through the command bus, here, and closes the list', () => {
    const one = fakeWindow(1, ['a'])
    const { handler, close, reopen, closedTabs } = rig([one], one)
    const entry = closedTabs.push({ kind: 'tab', index: 0, windowKey: 1, tab: { url: 'https://old.example/', title: 'Old', pinned: false } })
    handler.show?.(undefined)
    handler.request({ type: 'reopen', entryId: entry.id })
    expect(close).toHaveBeenCalledTimes(1)
    expect(reopen).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: entry.id }), one.shell)
  })

  it('does nothing for an id or an entry that does not exist', () => {
    const one = fakeWindow(1, ['a'])
    const { handler, close, reopen } = rig([one], one)
    handler.show?.(undefined)
    handler.request({ type: 'activate', id: 'nope' })
    handler.request({ type: 'close', id: 'nope' })
    handler.request({ type: 'reopen', entryId: 404 })
    expect(close).not.toHaveBeenCalled()
    expect(reopen).not.toHaveBeenCalled()
    expect(one.calls).toEqual([])
  })

  it.each([
    undefined, null, 'activate', 42, [], {},
    { type: 'activate' }, { type: 'activate', id: 7 }, { type: 'activate', id: '' }, { type: 'activate', id: 'x'.repeat(65) },
    { type: 'close', id: { toString: () => 'a' } }, { type: 'reopen', entryId: '1' }, { type: 'reopen', entryId: 1.5 }, { type: 'reopen', entryId: Number.NaN },
    { type: 'quit', id: 'a' }, { type: '__proto__', id: 'a' }
  ])('ignores the malformed request %j', (command) => {
    const one = fakeWindow(1, ['a'])
    const { handler, close, reopen } = rig([one], one)
    handler.show?.(undefined)
    expect(() => handler.request(command)).not.toThrow()
    expect(close).not.toHaveBeenCalled()
    expect(reopen).not.toHaveBeenCalled()
    expect(one.calls).toEqual([])
  })
})

describe('keeping the list current', () => {
  it('sends one update for a burst of changes, after the interval', () => {
    const one = fakeWindow(1, ['a'])
    const { handler, send } = rig([one], one)
    handler.show?.(undefined)
    one.push()
    one.push()
    one.state = [{ id: 'a', title: 'Renamed' }]
    one.push()
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(PUSH_INTERVAL_MS)
    expect(send).toHaveBeenCalledTimes(1)
    const event = send.mock.calls[0]?.[0] as { type: string, rows: Array<{ title: string }> }
    expect(event.type).toBe('rows')
    expect(event.rows[0]?.title).toBe('Renamed')
  })

  it('updates when a tab closes in another window, and when the closed stack changes', () => {
    const one = fakeWindow(1, ['a'])
    const two = fakeWindow(2, ['c'])
    const { handler, send, closedTabs } = rig([one, two], one)
    handler.show?.(undefined)
    two.push()
    vi.advanceTimersByTime(PUSH_INTERVAL_MS)
    closedTabs.push({ kind: 'tab', index: 0, windowKey: 2, tab: { url: 'https://old.example/', title: 'Old', pinned: false } })
    vi.advanceTimersByTime(PUSH_INTERVAL_MS)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('closes the list when the person moves to another tab of this window some other way', () => {
    const one = fakeWindow(1, ['a', 'b'])
    const two = fakeWindow(2, ['c'])
    const { handler, close, lifecycle } = rig([one, two], one)
    handler.show?.(undefined)
    lifecycle.tabActivated({ tab: 'c' } as never)
    expect(close).not.toHaveBeenCalled()
    lifecycle.tabActivated({ tab: 'b' } as never)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('stops listening and sends nothing once closed', () => {
    const one = fakeWindow(1, ['a'])
    const { handler, send, closedTabs, lifecycle } = rig([one], one)
    handler.show?.(undefined)
    expect(one.listeners.size).toBe(1)
    one.push()
    handler.closed?.('blur')
    expect(one.listeners.size).toBe(0)
    closedTabs.push({ kind: 'tab', index: 0, windowKey: 1, tab: { url: 'https://old.example/', title: 'Old', pinned: false } })
    lifecycle.tabCreated({} as never, undefined)
    vi.advanceTimersByTime(PUSH_INTERVAL_MS * 3)
    expect(send).not.toHaveBeenCalled()
  })

  it('does not subscribe twice when shown again while open', () => {
    const one = fakeWindow(1, ['a'])
    const { handler } = rig([one], one)
    handler.show?.(undefined)
    handler.show?.(undefined)
    expect(one.listeners.size).toBe(1)
  })
})

describe('ordering by recency', () => {
  it('lists the tab most recently in front first, and the current one last', () => {
    const one = fakeWindow(1, ['a', 'b', 'c'], 'c')
    const { handler, lifecycle } = rig([one], one)
    handler.show?.(undefined)
    lifecycle.tabActivated({ tab: 'b' } as never)
    lifecycle.tabActivated({ tab: 'a' } as never)
    const rows = showRows(handler)
    expect(rows.map((row) => row.kind === 'tab' && row.id)).toEqual(['a', 'b', 'c'])
  })
})
