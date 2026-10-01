import { describe, expect, it, vi } from 'vitest'
import type { InternalCaller } from '../../pages/internal-ipc.js'
import { historyDomain } from '../history-domain.js'
import type { HistoryService } from '../history-service.js'
import type { HistoryEntry } from '../history-store.js'

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const CALLER = { page: 'history', contents: {} } as unknown as InternalCaller

const page = (id: number, url: string): HistoryEntry => ({ id, url, title: `T${String(id)}`, lastVisit: id, visitCount: 1 })
const PAGES = [page(1, 'https://a.example/'), page(2, 'https://b.example/'), page(3, 'javascript:alert(1)'), page(4, 'https://d.example/')]

function setup (closed: unknown[] = []): {
  call: (command: unknown) => unknown
  tabs: { navigate: ReturnType<typeof vi.fn>, createTab: ReturnType<typeof vi.fn> }
  openWindow: ReturnType<typeof vi.fn>
  reopen: ReturnType<typeof vi.fn>
  copyText: ReturnType<typeof vi.fn>
  windows: { findTab: ReturnType<typeof vi.fn> }
} {
  const history = {
    pagesByIds: (ids: number[]) => ids.flatMap((id) => PAGES.find((candidate) => candidate.id === id) ?? []),
    faviconsFor: (hosts: string[]) => Object.fromEntries(hosts.filter((host) => host === 'a.example').map((host) => [host, PNG])),
    status: () => ({})
  }
  const tabs = { navigate: vi.fn(), createTab: vi.fn() }
  const shell = { tabs, window: { getBounds: () => ({ x: 10, y: 20, width: 800, height: 600 }) } }
  const windows = { findTab: vi.fn(() => ({ window: shell, tabId: 'tab-1' })) }
  const openWindow = vi.fn()
  const reopen = vi.fn(() => 'opened')
  const copyText = vi.fn()
  const domain = historyDomain(history as unknown as HistoryService, { windows: windows as never, commands: { openWindow, reopen } as never, closedTabs: { list: () => closed } as never, copyText })
  return { call: (command) => domain.handle(command, CALLER), tabs, openWindow, reopen, copyText, windows }
}

describe('the History page acting on a row by id', () => {
  it('opens a page in the tab it was asked from, a new tab, or the background', () => {
    const { call, tabs } = setup()
    call({ type: 'open', id: 1, disposition: 'tab' })
    expect(tabs.navigate).toHaveBeenCalledExactlyOnceWith('tab-1', 'https://a.example/')
    call({ type: 'open', id: 2, disposition: 'newTab' })
    expect(tabs.createTab).toHaveBeenLastCalledWith('https://b.example/', true)
    call({ type: 'open', id: 2, disposition: 'background' })
    expect(tabs.createTab).toHaveBeenLastCalledWith('https://b.example/', false)
  })

  it('opens a page in a new window of its own, a little down and to the right', () => {
    const { call, openWindow } = setup()
    call({ type: 'open', id: 1, disposition: 'window' })
    const options = openWindow.mock.calls[0]?.[0] as { place: object, first: (tabs: { createTab: (url: string) => void }) => void }
    expect(options.place).toMatchObject({ x: 38, y: 48 })
    const createTab = vi.fn()
    options.first({ createTab })
    expect(createTab).toHaveBeenCalledWith('https://a.example/')
  })

  it('refuses an id that is not a whole number, a disposition it does not know, and an address a tab may not open', () => {
    const { call, tabs } = setup()
    expect(call({ type: 'open', id: '1', disposition: 'tab' })).toBeUndefined()
    expect(call({ type: 'open', id: 1.5, disposition: 'tab' })).toBeUndefined()
    expect(call({ type: 'open', id: 1, disposition: 'popup' })).toBeUndefined()
    expect(call({ type: 'open', id: 1 })).toBeUndefined()
    call({ type: 'open', id: 3, disposition: 'tab' })
    call({ type: 'open', id: 99, disposition: 'tab' })
    expect(tabs.navigate).not.toHaveBeenCalled()
    expect(tabs.createTab).not.toHaveBeenCalled()
  })

  it('opens several in the background, at most twenty, and never the address of a refused one', () => {
    const { call, tabs } = setup()
    call({ type: 'openMany', ids: [1, 3, 4] })
    expect(tabs.createTab.mock.calls).toEqual([['https://a.example/', false], ['https://d.example/', false]])
    expect(call({ type: 'openMany', ids: Array.from({ length: 21 }, (_, n) => n) })).toBeUndefined()
    expect(call({ type: 'openMany', ids: Array.from({ length: 20 }, (_, n) => n) })).toEqual({ ok: true })
    expect(call({ type: 'openMany', ids: [1, 'x'] })).toBeUndefined()
  })

  it('does nothing for a caller that is not a tab in a window', () => {
    const { call, tabs, windows } = setup()
    windows.findTab.mockReturnValue(null)
    call({ type: 'open', id: 1, disposition: 'tab' })
    expect(tabs.navigate).not.toHaveBeenCalled()
  })

  it('copies the address of a page, read from the history and never from the request', () => {
    const { call, copyText } = setup()
    call({ type: 'copy', id: 2, url: 'https://evil.example/' })
    expect(copyText).toHaveBeenCalledExactlyOnceWith('https://b.example/')
    expect(call({ type: 'copy', id: 'x' })).toBeUndefined()
    call({ type: 'copy', id: 99 })
    expect(copyText).toHaveBeenCalledTimes(1)
  })
})

describe('the tabs closed a moment ago', () => {
  const tab = { id: 7, at: 1000, kind: 'tab', tab: { url: 'https://a.example/x', title: 'Ex', pinned: false }, index: 0, windowKey: 1 }
  const window = { id: 8, at: 2000, kind: 'window', window: { bounds: {}, maximized: false, active: 0, tabs: [{ url: 'https://b.example/', title: 'B' }, { url: 'https://c.example/', title: '' }] } }

  it('are listed with their icon and what a window holds, at most eight', () => {
    const many = Array.from({ length: 12 }, (_, n) => ({ ...tab, id: n }))
    expect((setup(many).call({ type: 'closed' }) as { rows: unknown[] }).rows).toHaveLength(8)
    const { rows } = setup([window, tab]).call({ type: 'closed' }) as { rows: Array<Record<string, unknown>> }
    expect(rows[0]).toMatchObject({ id: 8, kind: 'window', tabs: 2, address: 'B, https://c.example/', favicon: null })
    expect(rows[1]).toMatchObject({ id: 7, kind: 'tab', title: 'Ex', address: 'https://a.example/x', favicon: PNG })
  })

  it('come back where they were, through the shell\'s own reopen, and only those still in the stack', () => {
    const { call, reopen } = setup([tab])
    expect(call({ type: 'reopen', id: 7 })).toEqual({ result: 'opened' })
    expect(reopen).toHaveBeenCalledExactlyOnceWith(tab, expect.anything())
    expect(call({ type: 'reopen', id: 99 })).toEqual({ result: 'gone' })
    expect(call({ type: 'reopen', id: 'x' })).toBeUndefined()
  })

  it('are not offered to a domain made without the means to open anything', () => {
    const domain = historyDomain({} as HistoryService)
    expect(domain.handle({ type: 'open', id: 1, disposition: 'tab' }, CALLER)).toBeUndefined()
    expect(domain.handle({ type: 'closed' }, CALLER)).toBeUndefined()
  })
})
