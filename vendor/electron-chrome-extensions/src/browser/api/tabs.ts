import { BrowserWindow } from 'electron'
import type { ExtensionContext } from '../context'
import type { ExtensionEvent } from '../router'
import {
  getAllWindows,
  matchesPattern,
  matchesTitlePattern,
  validateExtensionUrl,
} from './common'
import type { TabContents } from './common'
import { WindowsAPI } from './windows'
import debug from 'debug'

const d = debug('electron-chrome-extensions:tabs')

/**
 * Orivon patch: an optional predicate deciding whether a tab's own url,
 * pendingUrl, title and favIconUrl may be returned to `manifest`'s
 * extension -- unset, every chrome.tabs.* call and event returns all four
 * regardless of permission (Chrome's own rule: the `tabs` permission, or a
 * host permission matching the tab's URL). Set once, before the first tabs
 * call (extension-host.ts).
 */
// Orivon patch (UPSTREAM.md patch 47): the extension's id and, when the
// answer is about one tab, that tab's id follow the url.
type TabUrlAccessCheck = (
  manifest: unknown,
  url: string | undefined,
  extensionId: string,
  tabId?: number,
) => boolean
let gTabUrlAccessCheck: TabUrlAccessCheck | undefined

export function setTabUrlAccessCheck(check: TabUrlAccessCheck): void {
  gTabUrlAccessCheck = check
}

const SENSITIVE_TAB_FIELDS = ['url', 'pendingUrl', 'title', 'favIconUrl'] as const

/** `details` as `event`'s own extension may see it: unchanged when
 * `gTabUrlAccessCheck` is unset or allows it, else a SHALLOW COPY with
 * SENSITIVE_TAB_FIELDS removed -- never a mutation in place, since
 * `details` can be the shared `tabDetailsCache` entry every extension's
 * call reads from. */
export function filterTabDetails(
  event: ExtensionEvent,
  details: Partial<chrome.tabs.Tab> | undefined,
): Partial<chrome.tabs.Tab> | undefined {
  if (!details) return details
  if (!gTabUrlAccessCheck || gTabUrlAccessCheck(event.extension.manifest, details.url, event.extension.id, details.id)) return details
  const filtered = { ...details }
  for (const field of SENSITIVE_TAB_FIELDS) delete (filtered as any)[field]
  return filtered
}

/**
 * Orivon patch: a second, stricter predicate for chrome.tabs.insertCSS --
 * Chrome only allows a CSS injection into a tab the extension has HOST
 * access to (a matching host_permissions entry), never merely the `tabs`
 * permission on its own (that permission only ever governs the four
 * SENSITIVE_TAB_FIELDS above). Unset, insertCSS runs for any extension
 * regardless of permissions. Set once, before the first insertCSS call
 * (extension-host.ts).
 */
type TabHostAccessCheck = (
  manifest: unknown,
  url: string | undefined,
  extensionId: string,
  tabId?: number,
) => boolean
let gTabHostAccessCheck: TabHostAccessCheck | undefined

export function setTabHostAccessCheck(check: TabHostAccessCheck): void {
  gTabHostAccessCheck = check
}

export class TabsAPI {
  static TAB_ID_NONE = -1
  static WINDOW_ID_NONE = -1
  static WINDOW_ID_CURRENT = -2

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('tabs.get', this.get.bind(this))
    handle('tabs.getAllInWindow', this.getAllInWindow.bind(this))
    handle('tabs.getCurrent', this.getCurrent.bind(this))
    handle('tabs.create', this.create.bind(this))
    handle('tabs.insertCSS', this.insertCSS.bind(this))
    handle('tabs.query', this.query.bind(this))
    handle('tabs.reload', this.reload.bind(this))
    handle('tabs.update', this.update.bind(this))
    handle('tabs.remove', this.remove.bind(this))
    handle('tabs.goForward', this.goForward.bind(this))
    handle('tabs.goBack', this.goBack.bind(this))

    this.ctx.store.on('tab-added', (tab: TabContents) => {
      this.observeTab(tab)
      this.announceIfActive(tab)
    })
    this.ctx.store.on('tab-moved', this.onMoved.bind(this))
  }

  /** Every webContents this instance has already attached its own
   * update/favicon/destroyed listeners to -- 'tab-added' fires again for
   * the SAME webContents when a tab is handed to another window (takeTab/
   * giveTab) or a one-tab window's view is replaced (removeTab then addTab
   * of the same object, extension-host.ts's own doc on `trackedTabs`);
   * without this guard, observeTab would attach a second, independent
   * listener set the 'destroyed' handler below never cleans up (it only
   * fires once, on the FIRST set, and only when the webContents is
   * actually destroyed -- never on the intervening remove+re-add). */
  private observedTabs = new WeakSet<TabContents>()

  private observeTab(tab: TabContents) {
    if (this.observedTabs.has(tab)) return
    this.observedTabs.add(tab)

    const tabId = tab.id

    const updateEvents = [
      'page-title-updated', // title
      'did-start-loading', // status
      'did-stop-loading', // status
      'media-started-playing', // audible
      'media-paused', // audible
      'did-start-navigation', // url
      'did-redirect-navigation', // url
      'did-navigate-in-page', // url

      // Listen for 'tab-updated' to handle all other cases which don't have
      // an official Electron API such as discarded tabs. App developers can
      // emit this event to trigger chrome.tabs.onUpdated if a property has
      // changed.
      'tab-updated',
    ]

    const updateHandler = () => {
      this.onUpdated(tabId)
    }

    updateEvents.forEach((eventName) => {
      tab.on(eventName as any, updateHandler)
    })

    const faviconHandler = (event: Electron.Event, favicons: string[]) => {
      const [favicon] = favicons
      if (favicon !== undefined) (tab as TabContents).favicon = favicon
      this.onUpdated(tabId)
    }
    tab.on('page-favicon-updated', faviconHandler)

    tab.once('destroyed', () => {
      updateEvents.forEach((eventName) => {
        tab.off(eventName as any, updateHandler)
      })
      tab.off('page-favicon-updated', faviconHandler)
      this.observedTabs.delete(tab)

      this.ctx.store.removeTab(tab)
      this.onRemoved(tabId)
    })

    this.onCreated(tabId)

    d(`Observing tab[${tabId}][${tab.getType()}] ${tab.getURL()}`)
  }

  private createTabDetails(tab: TabContents) {
    const tabId = tab.id
    const activeTab = this.ctx.store.getActiveTabFromWebContents(tab)
    let win = this.ctx.store.tabToWindow.get(tab)
    if (win?.isDestroyed()) win = undefined
    const [width = 0, height = 0] = win ? win.getSize() : []

    const details: chrome.tabs.Tab = {
      active: activeTab?.id === tabId,
      audible: tab.isCurrentlyAudible(),
      autoDiscardable: true,
      discarded: false,
      favIconUrl: tab.favicon || undefined,
      frozen: false,
      height,
      highlighted: false,
      id: tabId,
      incognito: false,
      index: -1, // TODO
      groupId: -1, // TODO(mv3): implement?
      mutedInfo: { muted: tab.audioMuted },
      pinned: false,
      selected: true,
      status: tab.isLoading() ? 'loading' : 'complete',
      title: tab.getTitle(),
      url: tab.getURL(), // TODO: tab.mainFrame.url (Electron 12)
      width,
      windowId: win ? win.id : -1,
    }

    if (typeof this.ctx.store.impl.assignTabDetails === 'function') {
      this.ctx.store.impl.assignTabDetails(details, tab)
    }

    this.ctx.store.tabDetailsCache.set(tab.id, details)
    return details
  }

  /** Orivon patch (UPSTREAM.md patch 60): the details `chrome.tabs.get` would answer for `tab`, unfiltered. */
  detailsFor(tab: TabContents) {
    return this.getTabDetails(tab)
  }

  private getTabDetails(tab: TabContents) {
    if (this.ctx.store.tabDetailsCache.has(tab.id)) {
      return this.ctx.store.tabDetailsCache.get(tab.id)
    }
    const details = this.createTabDetails(tab)
    return details
  }

  private get(event: ExtensionEvent, tabId: number) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) return { id: TabsAPI.TAB_ID_NONE }
    return filterTabDetails(event, this.getTabDetails(tab))
  }

  /** Orivon patch (UPSTREAM.md patch 65): the window a call is made from -- the window of the tab
   * it comes from, or the one a popup hangs under -- else the last focused one, as for a
   * background page. */
  private currentWindowId(event: ExtensionEvent): number | undefined {
    if (event.type === 'frame') {
      const own =
        this.ctx.store.tabToWindow.get(event.sender) ??
        BrowserWindow.fromWebContents(event.sender)?.getParentWindow()
      if (own && !own.isDestroyed()) return own.id
    }
    return this.ctx.store.lastFocusedWindowId
  }

  private getAllInWindow(event: ExtensionEvent, windowId: number = TabsAPI.WINDOW_ID_CURRENT) {
    if (windowId === TabsAPI.WINDOW_ID_CURRENT) windowId = this.currentWindowId(event)!

    const tabs = Array.from(this.ctx.store.tabs).filter((tab) => {
      if (tab.isDestroyed()) return false

      const browserWindow = this.ctx.store.tabToWindow.get(tab)
      if (!browserWindow || browserWindow.isDestroyed()) return

      return browserWindow.id === windowId
    })

    return tabs.map(this.getTabDetails.bind(this)).map((details) => filterTabDetails(event, details))
  }

  private getCurrent(event: ExtensionEvent) {
    const tab = this.ctx.store.getActiveTabOfCurrentWindow()
    return tab ? filterTabDetails(event, this.getTabDetails(tab)) : undefined
  }

  private async create(event: ExtensionEvent, details: chrome.tabs.CreateProperties = {}) {
    const url = details.url ? validateExtensionUrl(details.url, event.extension) : undefined
    const tab = await this.ctx.store.createTab({ ...details, url })
    const tabDetails = this.getTabDetails(tab)
    if (details.active) {
      queueMicrotask(() => this.onActivated(tab.id))
    }
    return filterTabDetails(event, tabDetails)
  }

  private insertCSS(event: ExtensionEvent, tabId: number, details: chrome.tabs.InjectDetails) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) return

    // Orivon patch: host access only -- the `tabs` permission alone (which
    // gTabUrlAccessCheck above also accepts) never authorizes an injection,
    // only visibility of url/title/favIconUrl (Chrome's own rule).
    if (gTabHostAccessCheck && !gTabHostAccessCheck(event.extension.manifest, tab.getURL(), event.extension.id, tab.id)) {
      throw new Error('tabs.insertCSS requires host access to the tab\'s URL')
    }

    // TODO: move to webFrame in renderer?
    if (details.code) {
      tab.insertCSS(details.code)
    }
  }

  private query(event: ExtensionEvent, info: chrome.tabs.QueryInfo = {}) {
    const isSet = (value: any) => typeof value !== 'undefined'
    const currentWindowId = this.currentWindowId(event)

    const filteredTabs = Array.from(this.ctx.store.tabs)
      .map(this.getTabDetails.bind(this))
      .map((details) => filterTabDetails(event, details))
      .filter((tab) => {
        if (!tab) return false
        if (isSet(info.active) && info.active !== tab.active) return false
        if (isSet(info.pinned) && info.pinned !== tab.pinned) return false
        if (isSet(info.audible) && info.audible !== tab.audible) return false
        if (isSet(info.muted) && info.muted !== tab.mutedInfo?.muted) return false
        if (isSet(info.highlighted) && info.highlighted !== tab.highlighted) return false
        if (isSet(info.discarded) && info.discarded !== tab.discarded) return false
        if (isSet(info.autoDiscardable) && info.autoDiscardable !== tab.autoDiscardable)
          return false
        // Orivon patch (UPSTREAM.md patch 65): both window filters.
        if (isSet(info.currentWindow) && info.currentWindow !== (tab.windowId === currentWindowId))
          return false
        if (
          isSet(info.lastFocusedWindow) &&
          info.lastFocusedWindow !== (tab.windowId === this.ctx.store.lastFocusedWindowId)
        )
          return false
        if (isSet(info.frozen) && info.frozen !== tab.frozen) return false
        if (isSet(info.groupId) && info.groupId !== tab.groupId) return false
        if (isSet(info.status) && info.status !== tab.status) return false
        // Orivon patch: `isSet(info.title)`/`isSet(info.url)` no longer only
        // guard the pattern match -- filterTabDetails above may have
        // stripped tab.title/tab.url for THIS extension, and a query that
        // filters on either must exclude that tab, not silently pass it
        // (Chrome's own rule: those filters see only what the extension
        // itself may see).
        if (isSet(info.title)) {
          if (typeof tab.title !== 'string') return false
          if (typeof info.title === 'string' && !matchesTitlePattern(info.title, tab.title)) return false
        }
        if (isSet(info.url)) {
          if (typeof tab.url !== 'string') return false
          if (typeof info.url === 'string' && !matchesPattern(info.url, tab.url)) {
            return false
          } else if (
            Array.isArray(info.url) &&
            !info.url.some((pattern) => matchesPattern(pattern, tab.url!))
          ) {
            return false
          }
        }
        if (isSet(info.windowId)) {
          if (info.windowId === TabsAPI.WINDOW_ID_CURRENT) {
            if (currentWindowId !== tab.windowId) return false
          } else if (info.windowId !== tab.windowId) {
            return false
          }
        }
        // if (isSet(info.windowType) && info.windowType !== tab.windowType) return false
        // if (isSet(info.index) && info.index !== tab.index) return false
        return true
      })
      .map((tab, index) => {
        if (tab) {
          tab.index = index
        }
        return tab
      })
    return filteredTabs
  }

  private reload(event: ExtensionEvent, arg1?: unknown, arg2?: unknown) {
    const tabId: number | undefined = typeof arg1 === 'number' ? arg1 : undefined
    const reloadProperties: chrome.tabs.ReloadProperties | null =
      typeof arg1 === 'object' ? arg1 : typeof arg2 === 'object' ? arg2 : {}

    const tab = tabId
      ? this.ctx.store.getTabById(tabId)
      : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) return

    if (reloadProperties?.bypassCache) {
      tab.reloadIgnoringCache()
    } else {
      tab.reload()
    }
  }

  private async update(event: ExtensionEvent, arg1?: unknown, arg2?: unknown) {
    let tabId = typeof arg1 === 'number' ? arg1 : undefined
    const updateProperties: chrome.tabs.UpdateProperties =
      (typeof arg1 === 'object' ? (arg1 as any) : (arg2 as any)) || {}

    const tab = tabId
      ? this.ctx.store.getTabById(tabId)
      : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) return

    tabId = tab.id

    const props = updateProperties

    const url = props.url ? validateExtensionUrl(props.url, event.extension) : undefined
    if (url) {
      // Orivon patch: routes through navigateTab (impl.ts) when the app
      // supplied one, instead of always loading the URL directly.
      const { navigateTab } = this.ctx.store.impl
      if (typeof navigateTab === 'function') await navigateTab(tab, url)
      else await tab.loadURL(url)
    }

    if (typeof props.muted === 'boolean') tab.setAudioMuted(props.muted)

    if (props.active) this.onActivated(tabId)

    this.onUpdated(tabId)

    return filterTabDetails(event, this.createTabDetails(tab))
  }

  private remove(event: ExtensionEvent, id: number | number[]) {
    const ids = Array.isArray(id) ? id : [id]

    ids.forEach((tabId) => {
      const tab = this.ctx.store.getTabById(tabId)
      if (tab) this.ctx.store.removeTab(tab)
      this.onRemoved(tabId)
    })
  }

  private goForward(event: ExtensionEvent, arg1?: unknown) {
    const tabId = typeof arg1 === 'number' ? arg1 : undefined
    const tab = tabId
      ? this.ctx.store.getTabById(tabId)
      : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) return
    tab.navigationHistory.goForward()
  }

  private goBack(event: ExtensionEvent, arg1?: unknown) {
    const tabId = typeof arg1 === 'number' ? arg1 : undefined
    const tab = tabId
      ? this.ctx.store.getTabById(tabId)
      : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) return
    tab.navigationHistory.goBack()
  }

  onCreated(tabId: number) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) return
    const tabDetails = this.getTabDetails(tab)
    this.ctx.router.broadcastEvent('tabs.onCreated', tabDetails)
  }

  onUpdated(tabId: number) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) return

    let prevDetails
    if (this.ctx.store.tabDetailsCache.has(tab.id)) {
      prevDetails = this.ctx.store.tabDetailsCache.get(tab.id)
    }
    if (!prevDetails) return

    const details = this.createTabDetails(tab)

    const compareProps: (keyof chrome.tabs.Tab)[] = [
      'audible',
      'autoDiscardable',
      'discarded',
      'favIconUrl',
      'frozen',
      'groupId',
      'pinned',
      'status',
      'title',
      'url',
    ]

    let didUpdate = false
    const changeInfo: chrome.tabs.TabChangeInfo = {}

    for (const prop of compareProps) {
      if (details[prop] !== prevDetails[prop]) {
        ;(changeInfo as any)[prop] = details[prop]
        didUpdate = true
      }
    }

    if (details.mutedInfo?.muted !== prevDetails.mutedInfo?.muted) {
      changeInfo.mutedInfo = details.mutedInfo
      didUpdate = true
    }

    if (!didUpdate) return

    this.ctx.router.broadcastEvent('tabs.onUpdated', tab.id, changeInfo, details)
  }

  onRemoved(tabId: number) {
    // Orivon patch (UPSTREAM.md patch 65): announced once. A tab removed through
    // chrome.tabs.remove() is destroyed right after, and its `destroyed` handler comes here
    // again with the details already gone.
    if (!this.ctx.store.tabDetailsCache.has(tabId)) return
    const details = this.ctx.store.tabDetailsCache.get(tabId)
    this.ctx.store.tabDetailsCache.delete(tabId)

    const windowId = details ? details.windowId : WindowsAPI.WINDOW_ID_NONE
    const win =
      typeof windowId !== 'undefined' && windowId > -1
        ? getAllWindows().find((win) => win.id === windowId)
        : null

    this.ctx.router.broadcastEvent('tabs.onRemoved', tabId, {
      windowId,
      isWindowClosing: win ? win.isDestroyed() : false,
    })
  }

  onActivated(tabId: number) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) return

    const activeTab = this.ctx.store.getActiveTabFromWebContents(tab)
    const activeChanged = activeTab?.id !== tabId
    if (!activeChanged) return

    const win = this.ctx.store.tabToWindow.get(tab)

    this.ctx.store.setActiveTab(tab)

    // invalidate cache since 'active' has changed -- in this tab's own window only
    this.ctx.store.tabDetailsCache.forEach((tabInfo, cacheTabId) => {
      if (cacheTabId === tabId) tabInfo.active = true
      else if (tabInfo.windowId === win?.id) tabInfo.active = false
    })

    this.ctx.router.broadcastEvent('tabs.onActivated', {
      tabId,
      windowId: win?.id,
    })
  }

  /** Orivon patch (UPSTREAM.md patch 65): a tab just added is announced as activated only when
   * it is the one in front of its window (the window's first, or the one that took the place of
   * the front tab); a tab opened behind the front one leaves that one active. */
  private announceIfActive(tab: TabContents) {
    if (this.ctx.store.getActiveTabFromWebContents(tab) !== tab) return
    this.ctx.router.broadcastEvent('tabs.onActivated', {
      tabId: tab.id,
      windowId: this.ctx.store.tabToWindow.get(tab)?.id,
    })
  }

  /** Orivon patch (UPSTREAM.md patch 65): a tab handed to another window keeps its id, so its
   * details are rebuilt for the new window and `onDetached`/`onAttached` say where it went. */
  private onMoved(tab: TabContents, from: Electron.BaseWindow, to: Electron.BaseWindow) {
    const cached = this.ctx.store.tabDetailsCache.get(tab.id)
    if (!cached) return
    this.createTabDetails(tab)
    this.ctx.router.broadcastEvent('tabs.onDetached', tab.id, {
      oldWindowId: from.id,
      oldPosition: 0,
    })
    this.ctx.router.broadcastEvent('tabs.onAttached', tab.id, {
      newWindowId: to.id,
      newPosition: 0,
    })
  }
}
