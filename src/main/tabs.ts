// Owns every tab's WebContentsView and the state pushed to the chrome UI.
//
// Main holds truth (build-plan.md's shell architecture, this session's plan):
// the chrome view sends commands (newTab, navigate, back, ...) and receives a
// full ShellState snapshot after every change. It never derives tab state
// itself.
//
// T18 (security-model.md): every tab WebContents gets setWindowOpenHandler
// wired to open a new tab rather than a popup. will-navigate origin-locking
// is deliberately NOT added here -- that lock applies to granted apps, which
// do not exist until build step 4, and ordinary tabs must browse freely.
import { WebContentsView, type View } from 'electron'
import { join } from 'node:path'
import type { Bookmark } from './bookmarks.js'
import { parseOmniboxInput, sanitizeDirectUrl } from './omnibox.js'

export interface TabState {
  id: string
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

/** What TabManager itself knows. Bookmarks are a separate store
 * (bookmarks.ts) that window.ts composes alongside this into the full
 * ShellState pushed to the chrome view -- TabManager has no reason to
 * know bookmarks exist. */
export interface TabsSnapshot {
  tabs: TabState[]
  activeTabId: string | null
}

export interface ShellState extends TabsSnapshot {
  bookmarks: Bookmark[]
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** Loaded for a fresh tab with no URL given -- never user input, so the
 * omnibox's dangerous-scheme rejection does not apply here. */
const NEW_TAB_URL = 'about:blank'

let nextId = 1
function makeTabId (): string {
  return `tab-${nextId++}`
}

export class TabManager {
  private readonly views = new Map<string, WebContentsView>()
  /** Tab strip order, separate from the Map's insertion-order guarantee so
   * reordering (not in this step's scope, but the seam matters) doesn't
   * require touching the Map. */
  private readonly order: string[] = []
  private activeId: string | null = null
  private readonly listeners = new Set<(state: TabsSnapshot) => void>()
  private readonly preloadPath: string

  constructor (
    private readonly contentView: View,
    private readonly getTabBounds: () => Bounds
  ) {
    this.preloadPath = join(import.meta.dirname, '../preload/app.js')
  }

  onStateChange (cb: (state: TabsSnapshot) => void): void {
    this.listeners.add(cb)
  }

  getState (): TabsSnapshot {
    return {
      tabs: this.order.map((id) => this.tabState(id)),
      activeTabId: this.activeId
    }
  }

  createTab (url?: string): string {
    const id = makeTabId()
    const view = new WebContentsView({
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true
      }
    })

    const wc = view.webContents
    wc.on('page-title-updated', () => this.emitState())
    wc.on('did-navigate', () => this.emitState())
    wc.on('did-navigate-in-page', () => this.emitState())
    wc.on('did-start-loading', () => this.emitState())
    wc.on('did-stop-loading', () => this.emitState())

    // T18: never let a tab open a real popup window -- route it to a new
    // tab in this same shell instead.
    wc.setWindowOpenHandler((details) => {
      this.createTab(details.url)
      return { action: 'deny' }
    })

    this.views.set(id, view)
    this.order.push(id)

    // `url` here is an ALREADY-A-URL argument (setWindowOpenHandler's
    // details.url, "open link in new tab") -- never typed address-bar
    // text, so it goes through sanitizeDirectUrl (reject dangerous
    // schemes and non-absolute garbage), not parseOmniboxInput's
    // search-fallback logic. Rejected/undefined both fall back to the
    // new-tab page, same as a rejected `navigate()` call.
    const target = url !== undefined ? (sanitizeDirectUrl(url) ?? NEW_TAB_URL) : NEW_TAB_URL
    void wc.loadURL(target)

    this.activateTab(id)
    return id
  }

  closeTab (id: string): void {
    const view = this.views.get(id)
    if (view === undefined) return

    if (this.activeId === id) {
      this.contentView.removeChildView(view)
    }
    view.webContents.close()
    this.views.delete(id)

    const idx = this.order.indexOf(id)
    if (idx !== -1) this.order.splice(idx, 1)

    if (this.activeId === id) {
      const fallback = this.order[Math.max(0, idx - 1)]
      this.activeId = null
      if (fallback !== undefined) {
        this.activateTab(fallback)
        return
      }
    }
    this.emitState()
  }

  activateTab (id: string): void {
    const view = this.views.get(id)
    if (view === undefined) return

    if (this.activeId !== null && this.activeId !== id) {
      const previous = this.views.get(this.activeId)
      if (previous !== undefined) this.contentView.removeChildView(previous)
    }

    if (this.activeId !== id) {
      this.contentView.addChildView(view)
      view.setBounds(this.getTabBounds())
    }

    this.activeId = id
    this.emitState()
  }

  /** Re-applies the active tab's bounds -- called on window resize. */
  layout (): void {
    if (this.activeId === null) return
    const view = this.views.get(this.activeId)
    if (view !== undefined) view.setBounds(this.getTabBounds())
  }

  navigate (id: string, rawInput: string): void {
    const view = this.views.get(id)
    if (view === undefined) return
    const target = this.resolveTarget(rawInput)
    void view.webContents.loadURL(target)
  }

  back (id: string): void {
    const history = this.views.get(id)?.webContents.navigationHistory
    if (history?.canGoBack() === true) history.goBack()
  }

  forward (id: string): void {
    const history = this.views.get(id)?.webContents.navigationHistory
    if (history?.canGoForward() === true) history.goForward()
  }

  reload (id: string): void {
    this.views.get(id)?.webContents.reload()
  }

  /** Rejected omnibox input (a dangerous scheme, or empty) never reaches
   * `loadURL` -- it falls back to the new-tab page rather than silently
   * doing nothing, so a bad paste has a visible, safe result. */
  private resolveTarget (rawInput: string): string {
    const result = parseOmniboxInput(rawInput)
    if (result.kind === 'reject') return NEW_TAB_URL
    return result.url
  }

  private tabState (id: string): TabState {
    const view = this.views.get(id)
    const wc = view?.webContents
    return {
      id,
      url: wc?.getURL() ?? '',
      title: wc?.getTitle() ?? '',
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      loading: wc?.isLoading() ?? false
    }
  }

  private emitState (): void {
    const state = this.getState()
    for (const listener of this.listeners) listener(state)
  }
}
