// Writes down what every window holds, and remembers a window that closes while others stay open.
// It builds nothing until the store asks: the windows change far faster than the file is written.
import type { ShellWindow } from '../shell/window-registry.js'
import type { ClosedStack } from './closed-stack.js'
import { groupsFor } from '../tab-groups/groups-model.js'
import { MAX_SESSION_WINDOWS, MAX_WINDOW_TABS, cleanBounds } from './session-types.js'
import type { SavedGroup, SavedWindow } from './session-types.js'
import type { SessionLog } from './session-store.js'
import { snapshotOf } from './tab-snapshot.js'
import type { TabSnapshot } from './tab-snapshot.js'

export interface RecorderDeps {
  readonly session: SessionLog
  readonly closed: ClosedStack
}

/** The window as it is now, or null once it is destroyed. `snapshot` is a seam for tests. */
export function snapshotWindow (shell: ShellWindow, snapshot: typeof snapshotOf = snapshotOf): SavedWindow | null {
  const { window, tabs } = shell
  if (window.isDestroyed()) return null
  const activeId = tabs.getState().activeTabId
  const saved: TabSnapshot[] = []
  const groups = groupsFor(tabs)
  const savedGroups: SavedGroup[] = []
  const savedGroupIds: string[] = []
  // Where the tab in front would sit among the saved ones, so a front tab that is not saved (the new-tab page) leaves a neighbour in front.
  let active = 0
  let activeKept = false
  for (const id of tabs.ids()) {
    if (id === activeId) active = saved.length
    const record = tabs.record(id)
    const tab = record === undefined ? null : snapshot(record, record.view.webContents)
    if (tab === null || saved.length >= MAX_WINDOW_TABS) continue
    if (id === activeId) activeKept = true
    const group = record?.groupId == null ? undefined : groups.get(record.groupId)
    if (group === undefined || record?.pinned === true) {
      saved.push(tab)
      continue
    }
    let at = savedGroupIds.indexOf(group.id)
    if (at === -1) {
      at = savedGroupIds.push(group.id) - 1
      savedGroups.push({ title: group.title, color: group.color, collapsed: group.collapsed })
    }
    saved.push({ ...tab, group: at })
  }
  active = Math.min(active, Math.max(0, saved.length - 1))
  if (!activeKept) active = nearestShown(saved, savedGroups, active)
  return { bounds: cleanBounds(window.getNormalBounds()), maximized: window.isMaximized(), active, tabs: saved, ...(savedGroups.length === 0 ? {} : { groups: savedGroups }) }
}

/** The place nearest `at` whose tab is not in a collapsed group: a neighbour put in front for a tab that is not saved should not be one the strip hides. */
function nearestShown (saved: readonly TabSnapshot[], groups: readonly SavedGroup[], at: number): number {
  const hidden = (place: number): boolean => { const group = saved[place]?.group; return group !== undefined && groups[group]?.collapsed === true }
  if (!hidden(at)) return at
  for (let distance = 1; distance < saved.length; distance += 1) {
    if (at - distance >= 0 && !hidden(at - distance)) return at - distance
    if (at + distance < saved.length && !hidden(at + distance)) return at + distance
  }
  return at
}

export class SessionRecorder {
  private readonly windows = new Set<ShellWindow>()
  /** The session as it was when the browser began to end: from then on the windows closing are part of it, not a change to it. */
  private frozen: SavedWindow[] | null = null
  /** The last window, closed outright: where the browser lives on without windows (macOS), one opened later puts it on the closed stack. */
  private lastClosed: SavedWindow | null = null
  private quitting = false

  constructor (private readonly deps: RecorderDeps, private readonly snapshot: (shell: ShellWindow) => SavedWindow | null = snapshotWindow) {
    deps.session.attach(() => this.current())
  }

  opened (shell: ShellWindow): void {
    if (this.quitting) return
    // A window opening after the last one closed (a resident app on macOS) starts a session of its own.
    if (this.lastClosed !== null) this.deps.closed.push({ kind: 'window', window: this.lastClosed })
    this.lastClosed = null
    this.frozen = null
    for (const other of this.windows) if (other.window.isDestroyed()) this.windows.delete(other)
    this.windows.add(shell)
    const changed = (): void => { this.deps.session.changed() }
    shell.window.on('resize', changed)
    shell.window.on('move', changed)
    shell.window.on('maximize', changed)
    shell.window.on('unmaximize', changed)
    let last = ''
    let lastTitles = ''
    /** Per tab, the address whose first title has been written: a later title there is the page retitling itself. */
    const titled = new Map<string, string>()
    shell.tabs.onStateChange(({ tabs, activeTabId }) => {
      // Loading progress and favicons push state too, and none of it is in the file. Titles are: the first one a
      // page takes at an address is written promptly (the address was written before the page had named itself),
      // while later ones there wait, so a page retitling itself twice a second does not rewrite the file as often.
      const seen = JSON.stringify([activeTabId, tabs.map((tab) => [tab.url, tab.pinned, tab.group ?? null]), groupsFor(shell.tabs).list()])
      const titles = JSON.stringify(tabs.map((tab) => tab.title))
      if (seen !== last) {
        last = seen
        lastTitles = titles
        changed()
        return
      }
      if (titles === lastTitles) return
      lastTitles = titles
      let firstTitle = false
      for (const tab of tabs) {
        if (titled.get(tab.id) === tab.url) continue
        titled.set(tab.id, tab.url)
        firstTitle = true
      }
      for (const id of titled.keys()) if (!tabs.some((tab) => tab.id === id)) titled.delete(id)
      if (firstTitle) changed()
      else this.deps.session.titlesChanged()
    })
    changed()
  }

  /** In the window's `close`, with its tabs still alive. */
  closing (shell: ShellWindow): void {
    if (this.quitting || !this.windows.has(shell)) return
    const saved = this.snapshot(shell)
    const othersOpen = [...this.windows].some((other) => other !== shell && !other.window.isDestroyed())
    if (othersOpen) {
      this.windows.delete(shell)
      if (saved !== null && saved.tabs.length > 0) this.deps.closed.push({ kind: 'window', window: saved })
    } else if (saved !== null) {
      // The last window closing usually ends the browser: the file keeps it as the session. One emptied by closing its
      // last tab keeps that tab, which would otherwise end with the closed stack it is on.
      const lastTab = saved.tabs.length > 0 ? undefined : this.lastTabClosedIn(shell)
      this.frozen = [lastTab === undefined ? saved : { ...saved, active: 0, tabs: [lastTab] }]
      this.lastClosed = saved.tabs.length > 0 ? saved : null
    }
    this.deps.session.changed()
  }

  private lastTabClosedIn (shell: ShellWindow): TabSnapshot | undefined {
    const top = this.deps.closed.peek()
    return top?.kind === 'tab' && top.windowKey === shell.window.id ? top.tab : undefined
  }

  /** The browser is quitting, and its windows are about to close one by one. */
  beforeQuit (): void {
    if (this.quitting) return
    this.quitting = true
    this.frozen ??= this.live()
    this.deps.session.finish()
  }

  private live (): SavedWindow[] {
    const saved: SavedWindow[] = []
    for (const shell of this.windows) {
      const window = this.snapshot(shell)
      if (window !== null) saved.push(window)
    }
    return saved.slice(0, MAX_SESSION_WINDOWS)
  }

  private current (): readonly SavedWindow[] {
    return this.frozen ?? this.live()
  }
}
