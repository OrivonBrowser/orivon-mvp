import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ShellWindow } from '../../shell/window-registry.js'
import type { TabRecord } from '../../shell/tab-types.js'
import { ClosedStack } from '../closed-stack.js'
import { SessionRecorder, snapshotWindow } from '../session-recorder.js'
import type { SessionLog, SessionSource } from '../session-store.js'
import type { SavedWindow } from '../session-types.js'

class FakeBaseWindow extends EventEmitter {
  destroyed = false
  isDestroyed (): boolean { return this.destroyed }
  getNormalBounds (): { x: number, y: number, width: number, height: number } { return { x: 1, y: 2, width: 800, height: 600 } }
  isMaximized (): boolean { return false }
}

interface Fake {
  shell: ShellWindow
  base: FakeBaseWindow
  push: (state: unknown) => void
  name: string
}

function fake (name: string): Fake {
  const base = new FakeBaseWindow()
  let listener: ((state: unknown) => void) | undefined
  const shell = { window: base, tabs: { onStateChange: (cb: (state: unknown) => void) => { listener = cb } } } as unknown as ShellWindow
  return { shell, base, name, push: (state) => { listener?.(state) } }
}

function fakeSession (): SessionLog & { source: SessionSource | null, changed: ReturnType<typeof vi.fn>, titlesChanged: ReturnType<typeof vi.fn>, finish: ReturnType<typeof vi.fn> } {
  const session = {
    source: null as SessionSource | null,
    changed: vi.fn(),
    titlesChanged: vi.fn(),
    finish: vi.fn(),
    load: async () => {},
    previous: () => null,
    attach: (source: SessionSource) => { session.source = source },
    flush: async () => {}
  }
  return session
}

const savedFor = (windows: Fake[]) => (shell: ShellWindow): SavedWindow | null => {
  const found = windows.find((candidate) => candidate.shell === shell)
  if (found === undefined || found.base.destroyed) return null
  return { bounds: { x: 0, y: 0, width: 800, height: 600 }, maximized: false, active: 0, tabs: [{ url: `https://${found.name}.example/`, title: found.name, pinned: false }] }
}

function setup (names: string[]): { recorder: SessionRecorder, windows: Fake[], session: ReturnType<typeof fakeSession>, closed: ClosedStack } {
  const windows = names.map(fake)
  const session = fakeSession()
  const closed = new ClosedStack()
  const recorder = new SessionRecorder({ session, closed }, savedFor(windows))
  for (const window of windows) recorder.opened(window.shell)
  return { recorder, windows, session, closed }
}

const destroy = (window: Fake | undefined): void => { if (window !== undefined) window.base.destroyed = true }
const urls = (session: { source: SessionSource | null }): string[] => (session.source?.() ?? []).flatMap((window) => window.tabs.map((tab) => tab.url))

describe('the session recorder', () => {
  it('writes every open window, when the store asks', () => {
    const { session } = setup(['a', 'b'])
    expect(urls(session)).toEqual(['https://a.example/', 'https://b.example/'])
    expect(session.changed).toHaveBeenCalled()
  })

  it('reports a window that moves, resizes or changes size class, and a change to the tabs', () => {
    const { windows, session } = setup(['a'])
    session.changed.mockClear()
    for (const event of ['resize', 'move', 'maximize', 'unmaximize']) windows[0]?.base.emit(event)
    expect(session.changed).toHaveBeenCalledTimes(4)
    session.changed.mockClear()
    windows[0]?.push({ activeTabId: 't', tabs: [{ url: 'https://a.example/', title: 'A', pinned: false, loading: true }] })
    expect(session.changed).toHaveBeenCalledTimes(1)
  })

  it('hands a change of titles alone to the slower title write, and an address change to the prompt one', () => {
    const { windows, session } = setup(['a'])
    windows[0]?.push({ activeTabId: 't', tabs: [{ url: 'https://a.example/', title: '(1) Inbox', pinned: false }] })
    session.changed.mockClear()
    windows[0]?.push({ activeTabId: 't', tabs: [{ url: 'https://a.example/', title: '(2) Inbox', pinned: false }] })
    expect(session.changed).not.toHaveBeenCalled()
    expect(session.titlesChanged).toHaveBeenCalledTimes(1)
    windows[0]?.push({ activeTabId: 't', tabs: [{ url: 'https://a.example/sent', title: 'Sent', pinned: false }] })
    expect(session.changed).toHaveBeenCalledTimes(1)
    expect(session.titlesChanged).toHaveBeenCalledTimes(1)
  })

  it('ignores a tab state that changes only in what the file does not hold', () => {
    const { windows, session } = setup(['a'])
    windows[0]?.push({ activeTabId: 't', tabs: [{ url: 'https://a.example/', title: 'A', pinned: false, loading: true }] })
    session.changed.mockClear()
    windows[0]?.push({ activeTabId: 't', tabs: [{ url: 'https://a.example/', title: 'A', pinned: false, loading: false, favicon: 'data:x' }] })
    expect(session.changed).not.toHaveBeenCalled()
  })

  it('takes a window that closes while others stay open out of the session, and puts it on the closed stack', () => {
    const { recorder, windows, session, closed } = setup(['a', 'b'])
    recorder.closing(windows[1]?.shell as ShellWindow)
    destroy(windows[1])
    expect(urls(session)).toEqual(['https://a.example/'])
    expect(closed.list()).toEqual([expect.objectContaining({ kind: 'window', window: expect.objectContaining({ tabs: [expect.objectContaining({ url: 'https://b.example/' })] }) })])
  })

  it('does not remember a window that had nothing to bring back', () => {
    const windows = [fake('a'), fake('b')]
    const closed = new ClosedStack()
    const recorder = new SessionRecorder({ session: fakeSession(), closed }, (shell) => ({ bounds: { x: 0, y: 0, width: 800, height: 600 }, maximized: false, active: 0, tabs: shell === windows[1]?.shell ? [] : [{ url: 'https://a.example/', title: '', pinned: false }] }))
    for (const window of windows) recorder.opened(window.shell)
    recorder.closing(windows[1]?.shell as ShellWindow)
    expect(closed.size).toBe(0)
  })

  it('keeps the last window in the session when it closes, and does not put it on the closed stack', () => {
    const { recorder, windows, session, closed } = setup(['a'])
    recorder.closing(windows[0]?.shell as ShellWindow)
    destroy(windows[0])
    expect(urls(session)).toEqual(['https://a.example/'])
    expect(closed.size).toBe(0)
  })

  it('freezes every window when the browser quits, so the windows closing after do not change it', () => {
    const { recorder, windows, session, closed } = setup(['a', 'b', 'c'])
    recorder.beforeQuit()
    expect(session.finish).toHaveBeenCalledTimes(1)
    for (const window of windows) {
      recorder.closing(window.shell)
      destroy(window)
    }
    expect(urls(session)).toEqual(['https://a.example/', 'https://b.example/', 'https://c.example/'])
    expect(closed.size).toBe(0)
    recorder.beforeQuit()
    expect(session.finish).toHaveBeenCalledTimes(1)
  })

  it('starts a session of its own when a window opens after the last one closed', () => {
    const { recorder, windows, session } = setup(['a'])
    recorder.closing(windows[0]?.shell as ShellWindow)
    destroy(windows[0])
    const later = fake('later')
    windows.push(later)
    recorder.opened(later.shell)
    expect(urls(session)).toEqual(['https://later.example/'])
    // ...and that window is the last one: closing it keeps it, and does not fill the closed stack.
    recorder.closing(later.shell)
    expect(urls(session)).toEqual(['https://later.example/'])
  })
})

describe('snapshotWindow', () => {
  function tabsOf (entries: Array<{ id: string, url: string | null }>, activeTabId: string | null): ShellWindow['tabs'] {
    return {
      getState: () => ({ activeTabId }),
      ids: () => entries.map((entry) => entry.id),
      record: (id: string) => ({ view: { webContents: { id } } }) as unknown as TabRecord
    } as unknown as ShellWindow['tabs']
  }
  const snap = (entries: Array<{ id: string, url: string | null }>) => (_record: TabRecord, wc: unknown): { url: string, title: string, pinned: boolean } | null => {
    const found = entries.find((entry) => entry.id === (wc as { id: string }).id)
    return found?.url == null ? null : { url: found.url, title: '', pinned: false }
  }

  it('gives the size, the tabs that are worth keeping and the one in front', () => {
    const entries = [{ id: '1', url: 'https://a.example/' }, { id: '2', url: null }, { id: '3', url: 'https://c.example/' }]
    const shell = { window: new FakeBaseWindow(), tabs: tabsOf(entries, '3') } as unknown as ShellWindow
    expect(snapshotWindow(shell, snap(entries) as never)).toEqual({ bounds: { x: 1, y: 2, width: 800, height: 600 }, maximized: false, active: 1, tabs: [expect.objectContaining({ url: 'https://a.example/' }), expect.objectContaining({ url: 'https://c.example/' })] })
  })

  it('puts a neighbour in front when the tab in front is not kept', () => {
    const entries = [{ id: '1', url: 'https://a.example/' }, { id: '2', url: null }]
    const shell = { window: new FakeBaseWindow(), tabs: tabsOf(entries, '2') } as unknown as ShellWindow
    expect(snapshotWindow(shell, snap(entries) as never)?.active).toBe(0)
  })

  it('gives nothing for a destroyed window', () => {
    const base = new FakeBaseWindow()
    base.destroyed = true
    expect(snapshotWindow({ window: base, tabs: tabsOf([], null) } as unknown as ShellWindow)).toBeNull()
  })
})
