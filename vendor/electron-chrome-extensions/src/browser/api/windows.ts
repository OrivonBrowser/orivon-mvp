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

const NON_NORMAL_STATES = ['minimized', 'maximized', 'fullscreen']

/**
 * Orivon patch (UPSTREAM.md patch 75): the combinations Chrome refuses in `windows.update`, as the message it would
 * give (undefined when the call is valid). A minimized, maximized or fullscreen window takes no bounds; a minimized
 * window cannot be focused, and a maximized or fullscreen one cannot be unfocused.
 */
export function windowUpdateError(props: chrome.windows.UpdateInfo): string | undefined {
  const state = props.state
  if (state === undefined || !NON_NORMAL_STATES.includes(state)) return undefined
  const bounds = [props.left, props.top, props.width, props.height].some((value) => value !== undefined)
  if (bounds) {
    return "Invalid value for state. 'minimized', 'maximized' and 'fullscreen' states cannot be combined with 'left', 'top', 'width' or 'height'."
  }
  if (state === 'minimized' && props.focused === true) {
    return "Invalid value for state. A 'minimized' window cannot be focused."
  }
  if (state !== 'minimized' && props.focused === false) {
    return "Invalid value for state. A 'maximized' or 'fullscreen' window cannot be unfocused."
  }
  return undefined
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
      this.ctx.store.removeWindow(window).catch((error: unknown) => { console.error('[extensions] removing a window failed:', error) })
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
      type: this.ctx.store.impl.windowType?.(win) ?? 'normal',
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

  /** Orivon patch (UPSTREAM.md patch 75): `QueryOptions.windowTypes` narrows by the type the host reports; none, or an empty list, is every type. */
  private ofTypes(getInfo?: chrome.windows.QueryOptions) {
    const types = getInfo?.windowTypes
    if (!Array.isArray(types) || types.length === 0) return () => true
    return (win: Electron.BaseWindow) => types.includes(this.ctx.store.impl.windowType?.(win) ?? 'normal')
  }

  private getLastFocused(event: ExtensionEvent, getInfo?: chrome.windows.QueryOptions) {
    const wanted = this.ofTypes(getInfo)
    const last = this.ctx.store.getLastFocusedWindow()
    // The last focused window of another type is passed over for the focused or newest one of the types asked for.
    const win =
      last && wanted(last)
        ? last
        : Array.from(this.ctx.store.windows).filter((candidate) => !candidate.isDestroyed() && wanted(candidate)).sort((a, b) => Number(b.isFocused()) - Number(a.isFocused()))[0]
    if (!win) return null
    return this.toExtensionWindow(event, this.getWindowDetails(win), getInfo?.populate === true)
  }

  private getAll(event: ExtensionEvent, getInfo?: chrome.windows.QueryOptions) {
    const populate = getInfo?.populate === true
    const wanted = this.ofTypes(getInfo)
    return Array.from(this.ctx.store.windows)
      .filter(wanted)
      .map((win) => this.toExtensionWindow(event, this.getWindowDetails(win), populate))
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
    const refused = windowUpdateError(props)
    if (refused) throw new Error(refused)

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

    this.ctx.store.impl.updateWindow?.(win, props)

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
