// What an extension's side panel does in each window: which extension is listed in the panel's picker, which one is
// showing, and what happens to it when the tab in front changes, the extension changes what it shows, or the
// extension goes away. The window's panel (../side-panel/side-panel-host.ts) draws whatever it is handed; this decides
// what that is. Everything it reaches comes through `deps`, so a test supplies fakes and side-panel-runner.ts
// supplies the real ones.
import type { PanelGuest } from '../side-panel/side-panel-host.js'
import type { PanelGuestEntry } from '../side-panel/side-panel-guests.js'
import type { ShellWindow } from '../shell/window-registry.js'
import type { PanelTarget } from './side-panel-api.js'
import type { SidePanelOptions } from './side-panel-options.js'

const ENTRY_PREFIX = 'ext:'

/** What a window's panel offers this: the part of `PanelHost` the driver calls. */
export interface PanelHostLike {
  canShow: () => boolean
  isOpen: () => boolean
  view: () => string
  open: (viewId?: string) => void
  close: () => void
  toggle: (viewId?: string) => void
  setGuest: (guest: PanelGuest | null) => void
  focusIn: () => void
  focusPage: () => void
  holdsFocus: () => boolean
}

/** One panel page: the view that draws it, and what its owner can do to it. */
export interface PanelPage {
  readonly view: PanelGuest['view']
  /** Settles when the first load has ended, whether or not it worked. */
  readonly ready: Promise<void>
  /** Settles once the page's contents are gone. */
  readonly destroyed: Promise<void>
  alive: () => boolean
  /** Loads another page of the extension in the same view; `keepFocus` says whether the panel held the keyboard before. */
  navigate: (url: string, keepFocus: boolean) => void
  destroy: () => void
}

export interface PanelPageEvents {
  /** The page's renderer died. */
  readonly gone: () => void
  /** The page's contents were destroyed by the page itself (its `window.close()`), or by anything else. */
  readonly destroyed: () => void
}

export type PanelEventName = 'onOpened' | 'onClosed'
export interface PanelEventInfo { readonly windowId: number, readonly tabId?: number, readonly path: string }

export interface PanelDriverDeps {
  readonly options: SidePanelOptions
  readonly windows: () => readonly ShellWindow[]
  readonly hostOf: (window: ShellWindow) => PanelHostLike | undefined
  /** The tab in front, as an extension names it; undefined when there is none or it is not an ordinary web tab (an app, an Orivon page). */
  readonly frontTab: (window: ShellWindow) => number | undefined
  /** Ids of the loaded extensions that hold `sidePanel`. */
  readonly candidates: () => readonly string[]
  readonly facts: (extensionId: string) => { readonly title: string, readonly icon?: string | undefined }
  readonly publish: (entries: readonly PanelGuestEntry[]) => void
  readonly createPage: (extensionId: string, window: ShellWindow, url: string, events: PanelPageEvents) => PanelPage
  readonly fire: (extensionId: string, name: PanelEventName, info: PanelEventInfo) => void
  /** The extension is between the two halves of a reload Orivon makes. */
  readonly reloading: (extensionId: string) => boolean
}

interface Shown { readonly ext: string, readonly page: PanelPage, url: string, path: string, readonly info: () => PanelEventInfo }
interface WindowState {
  loading?: { ext: string, page: PanelPage } | undefined
  shown?: Shown | undefined
  /** The panel stays open without the extension while the tab in front has none; `viewAfter` is what it showed instead. */
  suspended?: { ext: string, viewAfter: string } | undefined
  /** `open({ tabId })` named a tab that is not in front: it opens when that tab comes forward. */
  pending?: { ext: string, tabId: number } | undefined
  /** The next attach is a consequence of a tab switch, not of the person asking for the panel: it takes no focus. */
  quiet?: boolean | undefined
}

export interface PanelDriver {
  /** The picker or an `open` chose `entryId` in `window`. */
  chosen: (window: ShellWindow, entryId: string) => void
  /** The tab in front of `window` changed, or what the extensions show did. */
  sync: (window: ShellWindow) => void
  optionsChanged: (extensionId: string) => void
  extensionLoaded: (extensionId: string) => void
  extensionUnloaded: (extensionId: string) => void
  tabClosed: (tabId: number) => void
  open: (target: PanelTarget) => Promise<void>
  close: (target: PanelTarget) => Promise<void>
  /** A toolbar click: toggles the panel when the extension asked for that and has one for the tab. True when it did. */
  actionClick: (extensionId: string, window: ShellWindow, tabId: number | undefined) => boolean
  /** The extension's own key for its panel: toggles it when the extension has one for the tab. */
  openFromKey: (extensionId: string, window: ShellWindow, tabId: number | undefined) => boolean
  /** "Open Side Panel" in the action's menu: opens it, never closes it. */
  openFromMenu: (extensionId: string, window: ShellWindow, tabId: number | undefined) => boolean
  /** Closes every panel page of the extension, and settles once they are gone. */
  closeAll: (extensionId: string) => Promise<void>
  republish: () => void
}

export function createPanelDriver (deps: PanelDriverDeps): PanelDriver {
  const states = new WeakMap<ShellWindow, WindowState>()
  const stateOf = (window: ShellWindow): WindowState => {
    let state = states.get(window)
    if (state === undefined) { state = {}; states.set(window, state) }
    return state
  }
  let published = '[]'
  /** The entries this driver put in the picker: a choice of any other entry is someone else's to answer. */
  let listed = new Set<string>()

  const entries = (except?: string): PanelGuestEntry[] => {
    const fronts = deps.windows().map((window) => deps.frontTab(window))
    const found: PanelGuestEntry[] = []
    for (const id of deps.candidates()) {
      if (id === except) continue
      const available = deps.options.panelFor(id) !== undefined || fronts.some((tab) => tab !== undefined && deps.options.panelFor(id, tab) !== undefined)
      if (!available) continue
      const facts = deps.facts(id)
      found.push({ id: `${ENTRY_PREFIX}${id}`, title: facts.title, ...(facts.icon === undefined ? {} : { icon: facts.icon }) })
    }
    return found
  }

  /** `except`: an extension that is going away and may still be listed as loaded while its unload is announced. */
  const republish = (except?: string): void => {
    const next = entries(except)
    listed = new Set(next.map((entry) => entry.id))
    const key = JSON.stringify(next)
    if (key === published) return
    published = key
    deps.publish(next)
  }

  const infoFor = (extensionId: string, window: ShellWindow, path: string): (() => PanelEventInfo) => () => {
    const tab = deps.frontTab(window)
    return { windowId: window.window.id, ...(tab !== undefined && deps.options.hasTabOptions(extensionId, tab) ? { tabId: tab } : {}), path }
  }

  const guestClosed = (state: WindowState, page: PanelPage): void => {
    const { shown } = state
    if (shown?.page === page) {
      state.shown = undefined
      deps.fire(shown.ext, 'onClosed', shown.info())
    }
    page.destroy()
  }

  /** Makes the page and, once its first load has ended, hands it to the window's panel. */
  const show = (window: ShellWindow, host: PanelHostLike, extensionId: string, url: string): void => {
    const state = stateOf(window)
    state.loading?.page.destroy()
    const quiet = state.quiet === true
    state.quiet = false
    const events: PanelPageEvents = {
      gone: () => { if (state.shown?.page === page) host.setGuest(null) },
      destroyed: () => {
        if (state.loading?.page === page) {
          state.loading = undefined
          // A page that closes itself before it is shown takes the panel with it: nothing would answer for the entry.
          if (host.view() === `${ENTRY_PREFIX}${extensionId}`) host.close()
        }
        // The page closed itself: the panel closes with it, as a page's `window.close()` closes a panel.
        if (state.shown?.page === page) { host.close(); guestClosed(state, page) }
      }
    }
    const page: PanelPage = deps.createPage(extensionId, window, url, events)
    state.loading = { ext: extensionId, page }
    void page.ready.then(() => {
      if (state.loading?.page !== page) { page.destroy(); return }
      state.loading = undefined
      if (!page.alive()) return
      const path = deps.options.get(extensionId, deps.frontTab(window)).path ?? ''
      const facts = deps.facts(extensionId)
      let released = false
      host.setGuest({
        id: `${ENTRY_PREFIX}${extensionId}`,
        title: facts.title,
        ...(facts.icon === undefined ? {} : { icon: facts.icon }),
        view: page.view,
        closed: () => { released = true; guestClosed(state, page) }
      })
      // A panel that was closed or moved on from while the page loaded closed it again at once.
      if (released) return
      state.shown = { ext: extensionId, page, url, path, info: infoFor(extensionId, window, path) }
      deps.fire(extensionId, 'onOpened', state.shown.info())
      if (!quiet) host.focusIn()
    })
  }

  const chosen = (window: ShellWindow, entryId: string): void => {
    const host = deps.hostOf(window)
    if (host === undefined || !listed.has(entryId)) return
    const extensionId = entryId.slice(ENTRY_PREFIX.length)
    const url = deps.options.panelFor(extensionId, deps.frontTab(window))
    if (url === undefined) {
      const state = stateOf(window)
      state.loading?.page.destroy()
      state.loading = undefined
      state.quiet = false
      host.setGuest(null)
      return
    }
    show(window, host, extensionId, url)
  }

  const sync = (window: ShellWindow): void => {
    const host = deps.hostOf(window)
    if (host === undefined) return
    const state = stateOf(window)
    const tab = deps.frontTab(window)

    if (state.pending !== undefined) {
      const { ext, tabId } = state.pending
      state.pending = undefined
      if (tab === tabId && deps.options.panelFor(ext, tab) !== undefined && host.canShow()) {
        state.quiet = true
        host.open(`${ENTRY_PREFIX}${ext}`)
        return
      }
    }

    const { shown } = state
    if (shown !== undefined) {
      const url = deps.options.panelFor(shown.ext, tab)
      if (url === undefined) {
        // The panel stays open on one of Orivon's own views until a tab with a panel of the extension is in front again.
        host.setGuest(null)
        state.suspended = { ext: shown.ext, viewAfter: host.view() }
      } else if (url !== shown.url) {
        shown.url = url
        shown.path = deps.options.get(shown.ext, tab).path ?? ''
        shown.page.navigate(url, host.holdsFocus())
      }
      return
    }

    const { suspended } = state
    if (suspended === undefined) return
    if (!host.isOpen() || host.view() !== suspended.viewAfter) { state.suspended = undefined; return }
    if (deps.options.panelFor(suspended.ext, tab) === undefined) return
    state.suspended = undefined
    state.quiet = true
    host.open(`${ENTRY_PREFIX}${suspended.ext}`)
  }

  const syncAll = (): void => { for (const window of deps.windows()) sync(window) }

  const targetTab = (target: PanelTarget): number | undefined => target.tabId ?? deps.frontTab(target.window)

  const openOrToggle = (extensionId: string, window: ShellWindow, tabId: number | undefined, toggle: boolean): boolean => {
    const host = deps.hostOf(window)
    if (host === undefined || !host.canShow() || deps.options.panelFor(extensionId, tabId) === undefined) return false
    republish()
    if (toggle) host.toggle(`${ENTRY_PREFIX}${extensionId}`)
    else host.open(`${ENTRY_PREFIX}${extensionId}`)
    return true
  }

  return {
    chosen,
    sync,
    republish,
    optionsChanged: () => { republish(); syncAll() },
    extensionLoaded: () => { republish(); syncAll() },
    extensionUnloaded: (extensionId) => {
      // The pages of a reload Orivon makes stay: the extension is loaded again in a moment and they are navigated to their own address.
      if (deps.reloading(extensionId)) return
      for (const window of deps.windows()) {
        const state = stateOf(window)
        if (state.loading?.ext === extensionId) { state.loading.page.destroy(); state.loading = undefined }
        if (state.suspended?.ext === extensionId) state.suspended = undefined
        if (state.pending?.ext === extensionId) state.pending = undefined
        const host = deps.hostOf(window)
        if (state.shown?.ext === extensionId || host?.view() === `${ENTRY_PREFIX}${extensionId}`) host?.setGuest(null)
      }
      republish(extensionId)
    },
    tabClosed: (tabId) => {
      deps.options.forgetTab(tabId)
      for (const window of deps.windows()) {
        const state = stateOf(window)
        if (state.pending?.tabId === tabId) state.pending = undefined
      }
      republish()
    },

    open: async (target) => {
      republish()
      const host = deps.hostOf(target.window)
      const windowId = target.window.window.id
      if (host === undefined || !host.canShow()) throw new Error(`The side panel cannot be shown in windowId: ${String(windowId)}.`)
      const tab = targetTab(target)
      if (deps.options.panelFor(target.extensionId, tab) === undefined) throw new Error(`No active side panel for windowId: ${String(windowId)}.`)
      const state = stateOf(target.window)
      if (target.tabId !== undefined && target.tabId !== deps.frontTab(target.window)) {
        state.pending = { ext: target.extensionId, tabId: target.tabId }
        return
      }
      host.open(`${ENTRY_PREFIX}${target.extensionId}`)
    },

    close: async (target) => {
      const host = deps.hostOf(target.window)
      const state = stateOf(target.window)
      if (state.pending?.ext === target.extensionId) state.pending = undefined
      if (host !== undefined && (state.shown?.ext === target.extensionId || state.loading?.ext === target.extensionId)) host.close()
    },

    actionClick: (extensionId, window, tabId) => {
      if (!deps.options.openOnActionClick(extensionId)) return false
      return openOrToggle(extensionId, window, tabId, true)
    },
    openFromKey: (extensionId, window, tabId) => openOrToggle(extensionId, window, tabId, true),
    openFromMenu: (extensionId, window, tabId) => openOrToggle(extensionId, window, tabId, false),

    closeAll: async (extensionId) => {
      const gone: Array<Promise<void>> = []
      for (const window of deps.windows()) {
        const state = stateOf(window)
        if (state.loading?.ext === extensionId) { gone.push(state.loading.page.destroyed); state.loading.page.destroy(); state.loading = undefined }
        if (state.shown?.ext === extensionId) { gone.push(state.shown.page.destroyed); deps.hostOf(window)?.setGuest(null) }
        if (state.suspended?.ext === extensionId) state.suspended = undefined
        if (state.pending?.ext === extensionId) state.pending = undefined
      }
      await Promise.all(gone)
    }
  }
}
