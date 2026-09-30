import { describe, expect, it, vi } from 'vitest'
import type { ShellWindow } from '../../shell/window-registry.js'
import { COMMANDS } from '../commands.js'
import { runCommand } from '../run-command.js'
import type { CommandDeps } from '../run-command.js'
import type { ShellServices } from '../../shell/shell-services.js'
import { ClosedStack } from '../../session-restore/closed-stack.js'
import * as pageCommands from '../../page-tools/page-commands.js'

// The page tools have tests of their own; here only that a key reaches them.
vi.mock('../../page-tools/page-commands.js', () => Object.fromEntries(['print', 'pdf', 'save', 'viewSource', 'screenshot', 'pip'].map((name) => [`${name}Command`, vi.fn(async () => {})])))
vi.mock('../../page-tools/real-deps.js', () => ({ realDeps: { real: true } }))

interface Tab { id: string, url: string, title: string, isNewTab: boolean, isInternal: boolean, splitWith: string | null, pinned: boolean, muted: boolean }
const tab = (id: string, extra: Partial<Tab> = {}): Tab => ({ id, url: `https://${id}.example/`, title: id, isNewTab: false, isInternal: false, splitWith: null, pinned: false, muted: false, ...extra })

function harness (tabs: Tab[], activeTabId: string | null, options: { kiosk?: boolean, homeUrl?: string } = {}): { target: ShellWindow, zoom: Record<'step' | 'reset', ReturnType<typeof vi.fn>>, devtools: Record<'toggle' | 'openConsole', ReturnType<typeof vi.fn>>, profiles: Record<'openPrivate', ReturnType<typeof vi.fn>>, calls: Record<string, ReturnType<typeof vi.fn>>, bookmarks: Record<string, ReturnType<typeof vi.fn>>, deps: CommandDeps & { openWindow: ReturnType<typeof vi.fn<() => void>>, quit: ReturnType<typeof vi.fn<() => void>> }, send: ReturnType<typeof vi.fn> } {
  const calls = Object.fromEntries(['createTab', 'navigate', 'closeTab', 'activateTab', 'back', 'forward', 'reload', 'openInternal', 'reloadIgnoringCache', 'stop', 'overlayShow', 'overlayToggle', 'moveTab', 'toggle', 'changed', 'setAudioMuted', 'focusOther', 'swap', 'rotate'].map((name) => [name, vi.fn()]))
  const send = vi.fn()
  const window = { close: vi.fn(), setFullScreen: vi.fn(), isFullScreen: vi.fn(() => false), isAlwaysOnTop: vi.fn(() => false), setAlwaysOnTop: vi.fn(), getBounds: vi.fn(() => ({ x: 10, y: 20, width: 800, height: 600 })) }
  const target = {
    window,
    chrome: { webContents: { focus: vi.fn(), send, isDestroyed: () => false } },
    tabs: {
      getState: () => ({ tabs, activeTabId }),
      tabCount: tabs.length,
      splits: { toggle: calls['toggle'], focusOther: calls['focusOther'], swap: calls['swap'], rotate: calls['rotate'], groups: { partnerOf: () => null } },
      record: (id: string) => ({ pinned: tabs.find((t) => t.id === id)?.pinned, muted: tabs.find((t) => t.id === id)?.muted, view: { webContents: { isDestroyed: () => false, setAudioMuted: calls['setAudioMuted'] } } }),
      ids: () => tabs.map((t) => t.id),
      hasRoom: () => true,
      liveWebContents: () => undefined,
      faviconFor: () => 'data:icon',
      activeWebContents: () => ({ reloadIgnoringCache: calls['reloadIgnoringCache'], stop: calls['stop'] }),
      ...calls
    },
    overlays: { show: calls['overlayShow'], toggle: calls['overlayToggle'], isOpen: () => false, close: vi.fn(), send: vi.fn() },
    shortcutsSuspended: () => false
  } as unknown as ShellWindow
  const bookmarks = { has: vi.fn(() => false), add: vi.fn(), remove: vi.fn(), children: vi.fn(() => []), findByUrl: vi.fn((): Array<{ id: string, added: number }> => []), addUrl: vi.fn(() => ({ id: 'made', added: 1 })) }
  const zoom = { step: vi.fn(), reset: vi.fn() }
  const devtools = { toggle: vi.fn(), openConsole: vi.fn() }
  const profiles = { openPrivate: vi.fn() }
  return { target, zoom, devtools, profiles, calls: { ...calls, close: window.close as never, setFullScreen: window.setFullScreen as never, setAlwaysOnTop: window.setAlwaysOnTop as never }, bookmarks, deps: { services: { bookmarks, zoom, devtools, profiles, closedTabs: new ClosedStack(), kiosk: options.kiosk === true, settings: { get: () => options.homeUrl ?? '', set: vi.fn() } } as unknown as ShellServices, openWindow: vi.fn<() => void>(), quit: vi.fn<() => void>() }, send }
}

describe('the tab-state commands', () => {
  it('pins the tab in front, and unpins it again', () => {
    const { target, calls, deps } = harness([tab('a'), tab('b')], 'b')
    runCommand('tab.pin', target, deps)
    expect(calls['moveTab']).toHaveBeenCalledWith('b', 0)
    const pinned = harness([tab('a', { pinned: true }), tab('b', { pinned: true })], 'b')
    runCommand('tab.pin', pinned.target, pinned.deps)
    expect(pinned.calls['moveTab']).toHaveBeenCalledWith('b', 1)
  })

  it('mutes the tab in front on its page and reports the change', () => {
    const { target, calls, deps } = harness([tab('a')], 'a')
    runCommand('tab.mute', target, deps)
    expect(calls['setAudioMuted']).toHaveBeenCalledWith(true)
    expect(calls['changed']).toHaveBeenCalled()
  })

  it('closes the other unpinned tabs, or those to the right, of the tab in front', () => {
    const strip = [tab('a', { pinned: true }), tab('b'), tab('c'), tab('d')]
    const others = harness(strip, 'c')
    runCommand('tab.closeOthers', others.target, others.deps)
    expect(others.calls['closeTab']?.mock.calls.map(([id]) => id)).toEqual(['b', 'd'])
    const right = harness(strip, 'b')
    runCommand('tab.closeRight', right.target, right.deps)
    expect(right.calls['closeTab']?.mock.calls.map(([id]) => id)).toEqual(['c', 'd'])
  })

  it('opens a copy of the tab in front beside it, and none for the new-tab page', () => {
    const { target, calls, deps } = harness([tab('a'), tab('b')], 'a')
    calls['createTab']?.mockReturnValue('c')
    runCommand('tab.duplicate', target, deps)
    expect(calls['createTab']).toHaveBeenCalledWith('https://a.example/')
    expect(calls['moveTab']).toHaveBeenCalledWith('c', 1)
    const blank = harness([tab('a', { isNewTab: true })], 'a')
    runCommand('tab.duplicate', blank.target, blank.deps)
    expect(blank.calls['createTab']).not.toHaveBeenCalled()
  })
})

describe('runCommand', () => {
  it('hands each page command to the page tools, the ones that write with the real dependencies', () => {
    const { target, deps } = harness([tab('a')], 'a')
    const expected: Array<[Parameters<typeof runCommand>[0], keyof typeof pageCommands, boolean]> = [
      ['page.print', 'printCommand', false], ['page.pdf', 'pdfCommand', true], ['page.save', 'saveCommand', true],
      ['page.viewSource', 'viewSourceCommand', false], ['page.screenshot', 'screenshotCommand', false], ['page.pip', 'pipCommand', false]
    ]
    for (const [id, name, withDeps] of expected) {
      runCommand(id, target, deps)
      expect(pageCommands[name], id).toHaveBeenCalledWith(...(withDeps ? [target, { real: true }] : [target]))
    }
  })

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

  it('asks the address bar module for a search, so the field is ready for the words of one', () => {
    const { target, send, deps } = harness([tab('a')], 'a')

    runCommand('nav.focusSearch', target, deps)

    expect(send).toHaveBeenCalledWith('orivon-shell:event', { type: 'module', module: 'address-suggest', payload: { type: 'focusSearch' } })
  })

  it('saves a page on the first press and opens the bubble; on a saved page it only opens the bubble, and never removes', () => {
    const asked = { type: 'module', module: 'bookmark-star', payload: { open: true } }
    const first = harness([tab('a')], 'a')
    runCommand('bookmark.toggle', first.target, first.deps)
    expect(first.bookmarks['addUrl']).toHaveBeenCalledWith({ url: 'https://a.example/', title: 'a', favicon: 'data:icon', parent: 'bar' })
    expect(first.send).toHaveBeenCalledWith(expect.any(String), asked)

    const second = harness([tab('a')], 'a')
    second.bookmarks['findByUrl']?.mockReturnValue([{ id: 'old', added: 1 }])
    runCommand('bookmark.toggle', second.target, second.deps)
    expect(second.bookmarks['addUrl']).not.toHaveBeenCalled()
    expect(second.bookmarks['remove']).not.toHaveBeenCalled()
    expect(second.send).toHaveBeenCalledWith(expect.any(String), asked)
  })

  it('bookmarks nothing, and opens no bubble, on the new-tab page or one of the shell\'s own pages', () => {
    for (const extra of [{ isNewTab: true }, { isInternal: true }]) {
      const { target, bookmarks, deps, send } = harness([tab('a', extra)], 'a')
      runCommand('bookmark.toggle', target, deps)
      expect(bookmarks['addUrl']).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()
    }
  })

  it('opens the Bookmark all tabs sheet when some tab has a site, and does nothing when none has', () => {
    const some = harness([tab('a'), tab('b', { isNewTab: true })], 'a')
    runCommand('bookmark.allTabs', some.target, some.deps)
    expect(some.calls['overlayShow']).toHaveBeenCalledWith('bookmark-all-tabs')
    const none = harness([tab('a', { isNewTab: true }), tab('b', { isInternal: true })], 'a')
    runCommand('bookmark.allTabs', none.target, none.deps)
    expect(none.calls['overlayShow']).not.toHaveBeenCalled()
  })

  it('opens windows, closes the window, toggles full screen and opens Settings', () => {
    const { target, calls, deps } = harness([tab('a')], 'a')

    runCommand('window.new', target, deps)
    runCommand('window.close', target, deps)
    runCommand('window.fullscreen', target, deps)
    runCommand('settings.open', target, deps)
    runCommand('app.quit', target, deps)

    expect(deps.quit).toHaveBeenCalledTimes(1)
    expect(deps.openWindow).toHaveBeenCalledExactlyOnceWith({ place: { x: 38, y: 48, width: 800, height: 600 } })
    expect(calls['close']).toHaveBeenCalledTimes(1)
    expect(calls['setFullScreen']).toHaveBeenCalledWith(true)
    expect(calls['openInternal']).toHaveBeenCalledWith('settings')
  })

  it('keeps the window on top, and lets it go again', () => {
    const { target, calls, deps } = harness([tab('a')], 'a')
    runCommand('window.alwaysOnTop', target, deps)
    expect(calls['setAlwaysOnTop']).toHaveBeenCalledWith(true)
  })

  it('goes home: the home page in this tab, else the new tab page unless that is what is showing', () => {
    const withHome = harness([tab('a')], 'a', { homeUrl: 'example.com' })
    runCommand('nav.home', withHome.target, withHome.deps)
    expect(withHome.calls['navigate']).toHaveBeenCalledWith('a', 'https://example.com/')

    const without = harness([tab('a')], 'a')
    runCommand('nav.home', without.target, without.deps)
    expect(without.calls['createTab']).toHaveBeenCalledTimes(1)

    const onNewTab = harness([tab('n', { isNewTab: true })], 'n')
    runCommand('nav.home', onNewTab.target, onNewTab.deps)
    expect(onNewTab.calls['createTab']).not.toHaveBeenCalled()
  })

  it('in a kiosk runs only what a kiosk allows', () => {
    const { target, calls, deps } = harness([tab('a')], 'a', { kiosk: true })
    for (const id of ['tab.new', 'tab.close', 'window.new', 'window.newPrivate', 'window.fullscreen', 'window.alwaysOnTop', 'settings.open', 'nav.home'] as const) runCommand(id, target, deps)
    expect(calls['createTab']).not.toHaveBeenCalled()
    expect(calls['closeTab']).not.toHaveBeenCalled()
    expect(calls['setFullScreen']).not.toHaveBeenCalled()
    expect(calls['setAlwaysOnTop']).not.toHaveBeenCalled()
    expect(calls['openInternal']).not.toHaveBeenCalled()
    expect(deps.openWindow).not.toHaveBeenCalled()

    runCommand('nav.reload', target, deps)
    runCommand('app.quit', target, deps)
    expect(calls['reload']).toHaveBeenCalledWith('a')
    expect(deps.quit).toHaveBeenCalledTimes(1)
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

  it('toggles developer tools on the active tab\'s page', () => {
    const { target, deps, devtools } = harness([tab('a')], 'a')
    runCommand('devtools.toggle', target, deps)
    expect(devtools.toggle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reloadIgnoringCache: expect.anything() }), target.window)
  })

  it('opens developer tools on the active tab\'s Console panel', () => {
    const { target, deps, devtools } = harness([tab('a')], 'a')
    runCommand('devtools.console', target, deps)
    expect(devtools.openConsole).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reloadIgnoringCache: expect.anything() }), target.window)
  })

  it('opens the About page and the task manager as shell pages', () => {
    const { target, calls, deps } = harness([tab('a')], 'a')
    runCommand('about.open', target, deps)
    runCommand('tasks.open', target, deps)
    expect(calls['openInternal']!.mock.calls).toEqual([['about'], ['tasks']])
  })

  it('stops the active tab\'s load', () => {
    const { target, calls, deps } = harness([tab('a')], 'a')

    runCommand('nav.stop', target, deps)

    expect(calls['stop']).toHaveBeenCalledTimes(1)
  })

  it('opens the find bar, and opens it with a step for Find next and Find previous while it is closed', () => {
    const { target, calls, deps } = harness([tab('a')], 'a')

    runCommand('find.open', target, deps)
    runCommand('find.next', target, deps)
    runCommand('find.previous', target, deps)

    expect(calls['overlayShow']).toHaveBeenNthCalledWith(1, 'find')
    expect(calls['overlayShow']).toHaveBeenNthCalledWith(2, 'find', undefined, { step: true })
    expect(calls['overlayShow']).toHaveBeenNthCalledWith(3, 'find', undefined, { step: false })
  })

  it('opens tab search, and closes it again when it is already open', () => {
    const { target, calls, deps } = harness([tab('a')], 'a')

    runCommand('tab.search', target, deps)

    expect(calls['overlayToggle']).toHaveBeenCalledExactlyOnceWith('tab-search')
  })

  it('moves the active tab along the strip, and opens a window for it only when it has company', () => {
    const { target, calls, deps } = harness([tab('a'), tab('b'), tab('c')], 'b')
    runCommand('tab.moveLeft', target, deps)
    runCommand('tab.moveRight', target, deps)
    expect(calls['moveTab']?.mock.calls).toEqual([['b', 0], ['b', 2]])

    runCommand('tab.moveToNewWindow', target, deps)
    expect(deps.openWindow).toHaveBeenCalledWith(expect.objectContaining({ place: { x: 38, y: 48, width: 800, height: 600 }, first: expect.any(Function) }))

    const alone = harness([tab('a')], 'a')
    runCommand('tab.moveToNewWindow', alone.target, alone.deps)
    expect(alone.deps.openWindow).not.toHaveBeenCalled()
  })

  it('moves a joined pair along the strip as one, from where the pair begins', () => {
    const pair = [tab('a'), tab('b', { splitWith: 'c' }), tab('c', { splitWith: 'b' }), tab('d')]
    for (const active of ['b', 'c']) {
      const { target, calls, deps } = harness(pair, active)
      runCommand('tab.moveLeft', target, deps)
      runCommand('tab.moveRight', target, deps)
      expect(calls['moveTab']?.mock.calls, active).toEqual([[active, 0], [active, 2]])
    }
  })

  it('works the split of the active tab', () => {
    const { target, calls, deps } = harness([tab('a'), tab('b')], 'b')
    runCommand('split.toggle', target, deps)
    runCommand('split.focusOther', target, deps)
    runCommand('split.swap', target, deps)
    runCommand('split.rotate', target, deps)
    for (const name of ['toggle', 'focusOther', 'swap', 'rotate']) expect(calls[name]).toHaveBeenCalledExactlyOnceWith('b')

    const none = harness([], null)
    for (const id of ['split.toggle', 'split.focusOther', 'split.swap', 'split.rotate'] as const) runCommand(id, none.target, none.deps)
    for (const name of ['toggle', 'focusOther', 'swap', 'rotate']) expect(none.calls[name]).not.toHaveBeenCalled()
  })

  it('starts a private session, and opens the Profiles page', () => {
    const { target, calls, deps, profiles } = harness([tab('a')], 'a')
    runCommand('window.newPrivate', target, deps)
    runCommand('profiles.open', target, deps)
    expect(profiles.openPrivate).toHaveBeenCalledTimes(1)
    expect(calls['openInternal']).toHaveBeenCalledWith('profiles')
  })

  it('opens the Downloads page', () => {
    const { target, calls, deps } = harness([tab('a')], 'a')
    runCommand('downloads.open', target, deps)
    expect(calls['openInternal']).toHaveBeenCalledWith('downloads')
  })
})
