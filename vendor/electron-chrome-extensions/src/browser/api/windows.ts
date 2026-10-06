import type { ExtensionContext } from '../context'
import type { ExtensionEvent } from '../router'
import { validateExtensionUrl } from './common'
import { filterTabDetails } from './tabs'
import debug from 'debug'

const d = debug('electron-chrome-extensions:windows')

const getWindowState = (win: Electron.BaseWindow): chrome.windows.Window['state'] => {
  if (win.isMaximized()) return 'maximized'
  if (win.isMinimized()) return 'minimized'
  if (win.isFullScreen()) return 'fullscreen'
  return 'normal'
}

export class WindowsAPI {
  static WINDOW_ID_NONE = -1
  static WINDOW_ID_CURRENT = -2

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('windows.get', this.get.bind(this))
    handle('windows.getCurrent', this.getCurrent.bind(this))
    handle('windows.getLastFocused', this.getLastFocused.bind(this))
    handle('windows.getAll', this.getAll.bind(this))
    handle('windows.create', this.create.bind(this))
    handle('windows.update', this.update.bind(this))
    handle('windows.remove', this.remove.bind(this))

    this.ctx.store.on('window-added', this.observeWindow.bind(this))
  }

  /** Every window this instance has already attached focus/resized/closed
   * listeners to -- 'window-added' fires again for a window that never
   * really left (extension-host.ts's own `trackedTabs` doc: a one-tab
   * window's only tab being removed then re-added, e.g. on a view
   * replacement, deletes and re-adds the WINDOW too as a side effect of
   * store.ts's own "clear window if it has no remaining tabs" cleanup);
   * without this guard, observeWindow would attach a second, independent
   * listener set the 'closed' handler below never fully cleans up (each
   * `.once('closed', ...)` fires exactly once, so two of them fire
   * onRemoved/removeWindow twice for the same window). */
  private observedWindows = new WeakSet<Electron.BaseWindow>()

  private observeWindow(window: Electron.BrowserWindow) {
    if (this.observedWindows.has(window)) return
    this.observedWindows.add(window)

    const windowId = window.id

    window.on('focus', () => {
      this.onFocusChanged(windowId)
    })

    window.on('resized', () => {
      this.onBoundsChanged(windowId)
    })

    window.once('closed', () => {
      this.observedWindows.delete(window)
      this.ctx.store.windowDetailsCache.delete(windowId)
      this.ctx.store.removeWindow(window)
      this.onRemoved(windowId)
    })

    this.onCreated(windowId)

    d(`Observing window[${windowId}]`)
  }

  private createWindowDetails(win: Electron.BaseWindow) {
    const details: Partial<chrome.windows.Window> = {
      id: win.id,
      focused: win.isFocused(),
      top: win.getPosition()[1],
      left: win.getPosition()[0],
      width: win.getSize()[0],
      height: win.getSize()[1],
      tabs: Array.from(this.ctx.store.tabs)
        .filter((tab) => {
          const ownerWindow = this.ctx.store.tabToWindow.get(tab)
          return ownerWindow?.isDestroyed() ? false : ownerWindow?.id === win.id
        })
        .map((tab) => this.ctx.store.tabDetailsCache.get(tab.id) as chrome.tabs.Tab)
        .filter(Boolean),
      incognito: !this.ctx.session.isPersistent(),
      type: 'normal', // TODO
      state: getWindowState(win),
      alwaysOnTop: win.isAlwaysOnTop(),
      sessionId: 'default', // TODO
    }

    this.ctx.store.windowDetailsCache.set(win.id, details)
    return details
  }

  private getWindowDetails(win: Electron.BaseWindow) {
    if (this.ctx.store.windowDetailsCache.has(win.id)) {
      return this.ctx.store.windowDetailsCache.get(win.id)
    }
    const details = this.createWindowDetails(win)
    return details
  }

  /**
   * Orivon patch: `details` (the CACHED, unfiltered copy every extension's
   * request shares -- same reasoning as tabDetailsCache) narrowed for
   * `event`'s own calling extension, into a fresh shallow copy so the
   * shared cache entry is never mutated: `tabs` is included only when
   * `populate` is true (Chrome's own default is false for get/getAll/
   * getCurrent/getLastFocused; update carries no populate option at all, so
   * it never gets one), and every included tab's own url/title/favIconUrl
   * still goes through filterTabDetails -- `tabs` permission or host access
   * to THAT tab, same as a direct tabs.get. Before this patch, every one of
   * get/getAll/getCurrent/getLastFocused/create/update returned every open
   * tab's url/title/favIconUrl to any extension regardless of permission.
   */
  private toExtensionWindow(
    event: ExtensionEvent,
    details: Partial<chrome.windows.Window> | undefined,
    populate: boolean,
  ): Partial<chrome.windows.Window> | undefined {
    if (!details) return details
    const copy: Partial<chrome.windows.Window> = { ...details }
    if (populate) {
      copy.tabs = (details.tabs ?? []).map(
        (tab) => filterTabDetails(event, tab) as chrome.tabs.Tab,
      )
    } else {
      delete copy.tabs
    }
    return copy
  }

  private getWindowFromId(id: number) {
    if (id === WindowsAPI.WINDOW_ID_CURRENT) {
      return this.ctx.store.getCurrentWindow()
    } else {
      return this.ctx.store.getWindowById(id)
    }
  }

  private get(event: ExtensionEvent, windowId: number, getInfo?: chrome.windows.QueryOptions) {
    const win = this.getWindowFromId(windowId)
    if (!win) return { id: WindowsAPI.WINDOW_ID_NONE }
    return this.toExtensionWindow(event, this.getWindowDetails(win), getInfo?.populate === true)
  }

  /** Orivon patch (UPSTREAM.md patch 70): the window the host places a calling page in (a side panel's), else the last focused one. */
  private getCurrent(event: ExtensionEvent, getInfo?: chrome.windows.QueryOptions) {
    const placed = event.type === 'frame' ? this.ctx.store.impl.windowOf?.(event.sender) : undefined
    if (placed && !placed.isDestroyed()) {
      return this.toExtensionWindow(event, this.getWindowDetails(placed), getInfo?.populate === true)
    }
    return this.getLastFocused(event, getInfo)
  }

  private getLastFocused(event: ExtensionEvent, getInfo?: chrome.windows.QueryOptions) {
    const win = this.ctx.store.getLastFocusedWindow()
    if (!win) return null
    return this.toExtensionWindow(event, this.getWindowDetails(win), getInfo?.populate === true)
  }

  private getAll(event: ExtensionEvent, getInfo?: chrome.windows.QueryOptions) {
    const populate = getInfo?.populate === true
    return Array.from(this.ctx.store.windows).map((win) =>
      this.toExtensionWindow(event, this.getWindowDetails(win), populate),
    )
  }

  private async create(event: ExtensionEvent, details: chrome.windows.CreateData) {
    if (details.url) {
      const urls = Array.isArray(details.url) ? details.url : [details.url]
      const resolved = urls.map((u) => validateExtensionUrl(u, event.extension))
      details = { ...details, url: Array.isArray(details.url) ? resolved : resolved[0] }
    }
    const win = await this.ctx.store.createWindow(event, details)
    // Populated by default: the tabs a create() call just asked for opened,
    // never a stranger's -- still filtered per this extension's own access.
    return this.toExtensionWindow(event, this.getWindowDetails(win), true)
  }

  private async update(
    event: ExtensionEvent,
    windowId: number,
    updateProperties: chrome.windows.UpdateInfo = {},
  ) {
    const win = this.getWindowFromId(windowId)
    if (!win) return

    const props = updateProperties

    if (props.state) {
      switch (props.state) {
        case 'maximized':
          win.maximize()
          break
        case 'minimized':
          win.minimize()
          break
        case 'normal': {
          if (win.isMinimized() || win.isMaximized()) {
            win.restore()
          }
          break
        }
      }
    }

    // update() takes no populate option -- never carries tabs (Chrome's own
    // behaviour; also closes the leak an unconditional `tabs` array here
    // used to hand any caller, filter or not).
    return this.toExtensionWindow(event, this.createWindowDetails(win), false)
  }

  private async remove(event: ExtensionEvent, windowId: number = WindowsAPI.WINDOW_ID_CURRENT) {
    const win = this.getWindowFromId(windowId)
    if (!win) return
    const removedWindowId = win.id
    await this.ctx.store.removeWindow(win)
    this.onRemoved(removedWindowId)
  }

  onCreated(windowId: number) {
    const window = this.ctx.store.getWindowById(windowId)
    if (!window) return
    const windowDetails = this.getWindowDetails(window)
    this.ctx.router.broadcastEvent('windows.onCreated', windowDetails)
  }

  onRemoved(windowId: number) {
    this.ctx.router.broadcastEvent('windows.onRemoved', windowId)
  }

  onFocusChanged(windowId: number) {
    if (this.ctx.store.lastFocusedWindowId === windowId) return

    this.ctx.store.lastFocusedWindowId = windowId
    this.ctx.router.broadcastEvent('windows.onFocusChanged', windowId)
  }

  onBoundsChanged(windowId: number) {
    const window = this.ctx.store.getWindowById(windowId)
    if (!window) return
    const windowDetails = this.createWindowDetails(window)
    this.ctx.router.broadcastEvent('windows.onBoundsChanged', windowDetails)
  }
}
