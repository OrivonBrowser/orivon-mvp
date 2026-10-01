// Tab search: a list of every open tab of every window of this process, and what was closed lately, that the
// person filters by typing. The rows are built in ./tab-search-model.ts and ranked by the page; this is the
// overlay's declaration, what a request does, and keeping an open list current.
import type { OverlayDef, OverlayHandler, OverlayWindow } from '../overlays/overlay-types.js'
import type { ShellServices } from '../shell/shell-services.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { Recency } from './recency.js'
import { searchRows } from './tab-search-model.js'
import type { SearchRow } from './tab-search-model.js'
import { asRequest } from './tab-search-requests.js'

export const TAB_SEARCH_OVERLAY = 'tab-search'
/** Changes that arrive together (a page loading sends several) become one update to the list. */
export const PUSH_INTERVAL_MS = 100

const recencies = new WeakMap<ShellServices, Recency>()

/** Built on the first use, since what it orders by only matters once the list has been opened; the windows
 * already open are taken to have been in front when it is built. */
function recencyFor (services: ShellServices): Recency {
  let recency = recencies.get(services)
  if (recency === undefined) {
    const made = new Recency(services.tabLifecycle, (contents) => services.windows.findTab(contents)?.tabId ?? null)
    for (const { tabs } of services.windows.all()) {
      const { activeTabId } = tabs.getState()
      if (activeTabId !== null) made.touch(activeTabId)
    }
    recencies.set(services, made)
    recency = made
  }
  return recency
}

const liveWindows = (services: ShellServices): ShellWindow[] => services.windows.all().filter((entry) => !entry.window.isDestroyed())

export function createTabSearch (win: OverlayWindow): OverlayHandler {
  const { window, services } = win
  const watching = new Map<ShellWindow, () => void>()
  const stops: Array<() => void> = []
  let timer: ReturnType<typeof setTimeout> | null = null
  /** True while the list itself closes a tab: the tab that takes its place is not the person moving on. */
  let closingFromList = false

  function rows (): SearchRow[] {
    return searchRows({
      windows: liveWindows(services).map((entry) => {
        const { tabs, activeTabId } = entry.tabs.getState()
        return { key: entry.window.id, current: entry === window, tabs, activeTabId }
      }),
      closed: services.closedTabs.list(),
      lastActive: recencyFor(services).map
    })
  }

  function schedule (): void {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      watchWindows()
      win.send({ type: 'rows', rows: rows() })
    }, PUSH_INTERVAL_MS)
  }

  /** A title or an icon changing is a state push of the window it is in; a window opened since is picked up here. */
  function watchWindows (): void {
    for (const entry of liveWindows(services)) {
      if (!watching.has(entry)) watching.set(entry, entry.tabs.onStateChange(schedule))
    }
  }

  function stop (): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
    for (const unsubscribe of [...watching.values(), ...stops]) unsubscribe()
    watching.clear()
    stops.length = 0
  }

  function start (): void {
    stop()
    watchWindows()
    stops.push(
      services.closedTabs.onChange(schedule),
      services.tabLifecycle.subscribe({
        tabCreated: schedule,
        tabClosed: schedule,
        viewReplaced: schedule,
        tabActivated: (contents) => {
          schedule()
          // Moving to another tab of this window by any other means than this list leaves the list behind.
          if (!closingFromList && window.tabs.findTabIdByWebContents(contents) !== null) win.close()
        }
      })
    )
  }

  const ownerOf = (id: string): ShellWindow | undefined => liveWindows(services).find((entry) => entry.tabs.ids().includes(id))

  function activate (id: string): void {
    const owner = ownerOf(id)
    if (owner === undefined) return
    win.close()
    owner.tabs.activateTab(id)
    if (owner !== window) {
      owner.window.show()
      owner.window.focus()
    }
    // The page the person chose is where the keys go next, in this window or another.
    owner.tabs.activeWebContents()?.focus()
  }

  function closeTab (id: string): void {
    const owner = ownerOf(id)
    if (owner === undefined) return
    closingFromList = true
    try { owner.tabs.closeTab(id) } finally { closingFromList = false }
  }

  function reopen (entryId: number): void {
    const entry = services.closedTabs.list().find((candidate) => candidate.id === entryId)
    if (entry === undefined) return
    win.close()
    services.commands.reopen(entry, window)
  }

  return {
    show: () => {
      start()
      return { rows: rows() }
    },
    request: (command) => {
      const asked = asRequest(command)
      if (asked === undefined) return
      if (asked.type === 'activate') activate(asked.id)
      else if (asked.type === 'close') closeTab(asked.id)
      else reopen(asked.entryId)
    },
    closed: stop
  }
}

export const tabSearchOverlay: OverlayDef = {
  name: TAB_SEARCH_OVERLAY,
  placement: { kind: 'area', at: 'top-center', width: 520 },
  surface: 'panel',
  focus: 'take',
  layer: 'popup',
  // A tab switch is left out: the list closes a tab itself and stays open, and closes on any other switch on its own.
  closeOn: { blur: true, tabSwitch: false, navigation: false, layout: true },
  keep: 'fresh',
  height: { initial: 140, min: 120, max: 420 },
  attach: (win) => createTabSearch(win)
}
