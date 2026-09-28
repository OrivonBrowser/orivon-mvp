import { describe, expect, it, vi } from 'vitest'
import type { BookmarkStore } from '../../browsing/bookmarks.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import { COMMANDS } from '../commands.js'
import { runCommand } from '../run-command.js'
import type { CommandDeps } from '../run-command.js'
import type { ZoomService } from '../../zoom/zoom-service.js'

interface Tab { id: string, url: string, title: string, isNewTab: boolean, isInternal: boolean }
const tab = (id: string, extra: Partial<Tab> = {}): Tab => ({ id, url: `https://${id}.example/`, title: id, isNewTab: false, isInternal: false, ...extra })

function harness (tabs: Tab[], activeTabId: string | null): { target: ShellWindow, zoom: Record<'step' | 'reset', ReturnType<typeof vi.fn>>, calls: Record<string, ReturnType<typeof vi.fn>>, bookmarks: Record<string, ReturnType<typeof vi.fn>>, deps: CommandDeps & { openWindow: ReturnType<typeof vi.fn<() => void>>, quit: ReturnType<typeof vi.fn<() => void>> }, send: ReturnType<typeof vi.fn> } {
  const calls = Object.fromEntries(['createTab', 'closeTab', 'activateTab', 'back', 'forward', 'reload', 'openInternal', 'reloadIgnoringCache'].map((name) => [name, vi.fn()]))
  const send = vi.fn()
  const window = { close: vi.fn(), setFullScreen: vi.fn(), isFullScreen: vi.fn(() => false) }
  const target = {
    window,
    chrome: { webContents: { focus: vi.fn(), send } },
    tabs: {
      getState: () => ({ tabs, activeTabId }),
      faviconFor: () => 'data:icon',
      activeWebContents: () => ({ reloadIgnoringCache: calls['reloadIgnoringCache'] }),
      ...calls
    },
    shortcutsSuspended: () => false
  } as unknown as ShellWindow
  const bookmarks = { has: vi.fn(() => false), add: vi.fn(), remove: vi.fn() }
  const zoom = { step: vi.fn(), reset: vi.fn() }
  return { target, zoom, calls: { ...calls, close: window.close as never, setFullScreen: window.setFullScreen as never }, bookmarks, deps: { bookmarks: bookmarks as unknown as BookmarkStore, zoom: zoom as unknown as ZoomService, openWindow: vi.fn<() => void>(), quit: vi.fn<() => void>() }, send }
}

describe('runCommand', () => {
  it('handles every command there is', () => {
    const { target, deps } = harness([tab('a')], 'a')
    for (const command of COMMANDS) expect(() => { runCommand(command.id, target, deps) }, command.id).not.toThrow()
  })

  it('opens and closes tabs', () => {
    const { target, calls, deps } = harness([tab('a'), tab('b')], 'b')

    runCommand('tab.new', target, deps)
    runCommand('tab.close', target, deps)

    expect(calls['createTab']).toHaveBeenCalledTimes(1)
    expect(calls['closeTab']).toHaveBeenCalledWith('b')
  })

  it('goes to the next and previous tab, wrapping at either end', () => {
    const three = [tab('a'), tab('b'), tab('c')]

    const last = harness(three, 'c')
    runCommand('tab.next', last.target, last.deps)
    expect(last.calls['activateTab']).toHaveBeenCalledWith('a')

    const first = harness(three, 'a')
    runCommand('tab.previous', first.target, first.deps)
    expect(first.calls['activateTab']).toHaveBeenCalledWith('c')
  })

  it('goes to a tab by number, and to the last', () => {
    const { target, calls, deps } = harness([tab('a'), tab('b'), tab('c')], 'a')

    runCommand('tab.goto2', target, deps)
    runCommand('tab.gotoLast', target, deps)
    runCommand('tab.goto8', target, deps)

    expect(calls['activateTab']).toHaveBeenNthCalledWith(1, 'b')
    expect(calls['activateTab']).toHaveBeenNthCalledWith(2, 'c')
    expect(calls['activateTab']).toHaveBeenCalledTimes(2)
  })

  it('does nothing to tabs when there is none, and nothing to the active tab when there is none', () => {
    const { target, calls, deps } = harness([], null)

    for (const id of ['tab.next', 'tab.previous', 'tab.close', 'nav.back', 'nav.forward', 'nav.reload', 'tab.gotoLast'] as const) runCommand(id, target, deps)

    for (const name of ['activateTab', 'closeTab', 'back', 'forward', 'reload']) expect(calls[name], name).not.toHaveBeenCalled()
  })

  it('navigates the active tab', () => {
    const { target, calls, deps } = harness([tab('a'), tab('b')], 'a')

    runCommand('nav.back', target, deps)
    runCommand('nav.forward', target, deps)
    runCommand('nav.reload', target, deps)
    runCommand('nav.hardReload', target, deps)

    expect(calls['back']).toHaveBeenCalledWith('a')
    expect(calls['forward']).toHaveBeenCalledWith('a')
    expect(calls['reload']).toHaveBeenCalledWith('a')
    expect(calls['reloadIgnoringCache']).toHaveBeenCalledTimes(1)
  })

  it('asks the chrome to take the address bar', () => {
    const { target, send, deps } = harness([tab('a')], 'a')

    runCommand('nav.focusAddress', target, deps)

    expect(send).toHaveBeenCalledWith('orivon-shell:event', { type: 'focusAddress' })
  })

  it('bookmarks a page and removes the bookmark on the second press, with its icon', () => {
    const first = harness([tab('a')], 'a')
    runCommand('bookmark.toggle', first.target, first.deps)
    expect(first.bookmarks['add']).toHaveBeenCalledWith({ url: 'https://a.example/', title: 'a', favicon: 'data:icon' })

    const second = harness([tab('a')], 'a')
    second.bookmarks['has']?.mockReturnValue(true)
    runCommand('bookmark.toggle', second.target, second.deps)
    expect(second.bookmarks['remove']).toHaveBeenCalledWith('https://a.example/')
  })

  it('bookmarks nothing on the new-tab page or one of the shell\'s own pages', () => {
    for (const extra of [{ isNewTab: true }, { isInternal: true }]) {
      const { target, bookmarks, deps } = harness([tab('a', extra)], 'a')
      runCommand('bookmark.toggle', target, deps)
      expect(bookmarks['add']).not.toHaveBeenCalled()
    }
  })

  it('opens windows, closes the window, toggles full screen and opens Settings', () => {
    const { target, calls, deps } = harness([tab('a')], 'a')

    runCommand('window.new', target, deps)
    runCommand('window.close', target, deps)
    runCommand('window.fullscreen', target, deps)
    runCommand('settings.open', target, deps)
    runCommand('app.quit', target, deps)

    expect(deps.quit).toHaveBeenCalledTimes(1)
    expect(deps.openWindow).toHaveBeenCalledTimes(1)
    expect(calls['close']).toHaveBeenCalledTimes(1)
    expect(calls['setFullScreen']).toHaveBeenCalledWith(true)
    expect(calls['openInternal']).toHaveBeenCalledWith('settings')
  })

  it('zooms the site the active page is on, and does nothing where a page has no site', () => {
    const site = harness([tab('a')], 'a')
    runCommand('zoom.in', site.target, site.deps)
    runCommand('zoom.out', site.target, site.deps)
    runCommand('zoom.reset', site.target, site.deps)
    expect(site.zoom.step).toHaveBeenNthCalledWith(1, 'https://a.example', 'in')
    expect(site.zoom.step).toHaveBeenNthCalledWith(2, 'https://a.example', 'out')
    expect(site.zoom.reset).toHaveBeenCalledWith('https://a.example')

    const blank = harness([tab('n', { url: 'about:blank', isNewTab: true })], 'n')
    for (const id of ['zoom.in', 'zoom.out', 'zoom.reset'] as const) runCommand(id, blank.target, blank.deps)
    expect(blank.zoom.step).not.toHaveBeenCalled()
    expect(blank.zoom.reset).not.toHaveBeenCalled()
  })
})
