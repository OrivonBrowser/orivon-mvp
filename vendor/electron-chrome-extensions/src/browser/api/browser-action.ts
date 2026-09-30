import { Menu, MenuItem, nativeImage } from 'electron'
import type { ExtensionContext } from '../context'
import { PopupView } from '../popup'
import type { ExtensionEvent } from '../router'
import {
  getExtensionUrl,
  getExtensionManifest,
  getIconPath,
  resolveExtensionPath,
  matchSize,
  ResizeType,
} from './common'
import debug from 'debug'

const d = debug('electron-chrome-extensions:browserAction')

// Orivon patch: the module-level protocol.registerSchemesAsPrivileged() call
// upstream makes here is removed. ADR-0041 gives Orivon exactly one call
// site for that API (src/main/pages/internal-session.ts, before ready);
// 'crx' is registered there instead, with the same privileges.

// Orivon patch (UPSTREAM.md, patch 33): an optional hook, the same shape as
// router.ts's own setEventListenerFilter/setMessageSenderIdCheck, called
// from activateClick below with the tab the toolbar action was just
// clicked on. chrome.tabCapture.getMediaStreamId requires this -- Chrome
// refuses to capture a tab the extension was never invoked on ("Extension
// has not been invoked for the current page"), and nothing in this library
// tracked that at all before this. Set once, before the first activation
// (extension-host.ts).
type TabCaptureInvocationRecorder = (extensionId: string, tab: Electron.WebContents) => void
let gTabCaptureInvocationRecorder: TabCaptureInvocationRecorder | undefined

export function setTabCaptureInvocationRecorder(recorder: TabCaptureInvocationRecorder): void {
  gTabCaptureInvocationRecorder = recorder
}

interface ExtensionAction {
  color?: string
  text?: string
  title?: string
  icon?: chrome.browserAction.TabIconDetails
  popup?: string
  /** Last modified date for icon. */
  iconModified?: number
}

type ExtensionActionKey = keyof ExtensionAction

interface ActivateDetails {
  eventType: string
  extensionId: string
  tabId: number
  anchorRect: { x: number; y: number; width: number; height: number }
  alignment?: string
}

const getBrowserActionDefaults = (extension: Electron.Extension): ExtensionAction | undefined => {
  const manifest = getExtensionManifest(extension)
  const browserAction =
    manifest.manifest_version === 3
      ? manifest.action
      : manifest.manifest_version === 2
        ? manifest.browser_action
        : undefined
  if (typeof browserAction === 'object') {
    const manifestAction: chrome.runtime.ManifestAction = browserAction
    const action: ExtensionAction = {}

    action.title = manifestAction.default_title || manifest.name

    const iconPath = getIconPath(extension)
    if (iconPath) action.icon = { path: iconPath }

    if (manifestAction.default_popup) {
      action.popup = manifestAction.default_popup
    }

    return action
  }
}

interface ExtensionActionStore extends Partial<ExtensionAction> {
  tabs: { [key: string]: ExtensionAction }
}

export class BrowserActionAPI {
  private actionMap = new Map</* extensionId */ string, ExtensionActionStore>()
  // Orivon patch: `| undefined` added (exactOptionalPropertyTypes) --
  // activateClick assigns `undefined` here, which the bare `?:` form
  // refuses.
  private popup?: PopupView | undefined
  // Orivon patch (UPSTREAM.md, patch 33): the tab `this.popup` was opened
  // for -- getOpenPopup() below is chrome.runtime.getContexts()'s only way
  // to report a POPUP context's tabId, since PopupView itself carries no
  // tab of its own.
  private popupTabId?: number | undefined

  private observers: Set<Electron.WebContents> = new Set()
  private queuedUpdate: boolean = false

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()

    const getter =
      (propName: ExtensionActionKey) =>
      ({ extension }: ExtensionEvent, details: chrome.browserAction.TabDetails = {}) => {
        const { tabId } = details
        const action = this.getAction(extension.id)

        let result

        if (tabId) {
          if (action.tabs[tabId]) {
            result = action.tabs[tabId][propName]
          } else {
            result = action[propName]
          }
        } else {
          result = action[propName]
        }

        return result
      }

    const setDetails = (
      { extension }: ExtensionEvent,
      details: any,
      propName: ExtensionActionKey,
    ) => {
      const { tabId } = details
      let value = details[propName]

      if (typeof value === 'undefined' || value === null) {
        const defaults = getBrowserActionDefaults(extension)
        value = defaults ? defaults[propName] : value
      }

      const valueObj = { [propName]: value }
      const action = this.getAction(extension.id)

      if (tabId) {
        const tabAction = action.tabs[tabId] || (action.tabs[tabId] = {})
        Object.assign(tabAction, valueObj)
      } else {
        Object.assign(action, valueObj)
      }

      this.onUpdate()
    }

    const setter =
      (propName: ExtensionActionKey) =>
      (event: ExtensionEvent, details: chrome.browserAction.TabDetails) =>
        setDetails(event, details, propName)

    const handleProp = (prop: string, key: ExtensionActionKey) => {
      handle(`browserAction.get${prop}`, getter(key))
      handle(`browserAction.set${prop}`, setter(key))
    }

    handleProp('BadgeBackgroundColor', 'color')
    handleProp('BadgeText', 'text')
    handleProp('Title', 'title')
    handleProp('Popup', 'popup')

    handle('browserAction.getUserSettings', (): chrome.action.UserSettings => {
      // TODO: allow extension pinning
      return { isOnToolbar: true }
    })

    // setIcon is unique in that it can pass in a variety of properties. Here we normalize them
    // to use 'icon'.
    handle(
      'browserAction.setIcon',
      (event, { tabId, ...details }: chrome.browserAction.TabIconDetails) => {
        // TODO: icon paths need to be resolved relative to the sender url. In
        // the case of service workers, we need an API to get the script url.
        setDetails(event, { tabId, icon: details }, 'icon')
        setDetails(event, { tabId, iconModified: Date.now() }, 'iconModified')
      },
    )

    handle('browserAction.openPopup', this.openPopup)

    // browserAction preload API
    const preloadOpts = { allowRemote: true, extensionContext: false }
    handle('browserAction.getState', this.getState.bind(this), preloadOpts)
    handle('browserAction.activate', this.activate.bind(this), preloadOpts)
    handle(
      'browserAction.addObserver',
      (event) => {
        if (event.type != 'frame') return
        const observer = event.sender
        this.observers.add(observer)
        observer.once?.('destroyed', () => {
          this.observers.delete(observer)
        })
      },
      preloadOpts,
    )
    handle(
      'browserAction.removeObserver',
      (event) => {
        if (event.type != 'frame') return
        const { sender: observer } = event
        this.observers.delete(observer)
      },
      preloadOpts,
    )

    this.ctx.store.on('active-tab-changed', () => {
      this.onUpdate()
    })

    // Clear out tab details when removed
    this.ctx.store.on('tab-removed', (tabId: number) => {
      for (const [, actionDetails] of this.actionMap) {
        if (actionDetails.tabs[tabId]) {
          delete actionDetails.tabs[tabId]
        }
      }
      this.onUpdate()
    })

    this.setupSession(this.ctx.session)
  }

  private setupSession(session: Electron.Session) {
    const sessionExtensions = session.extensions || session
    sessionExtensions.on('extension-loaded', (event, extension) => {
      this.processExtension(extension)
    })

    sessionExtensions.on('extension-unloaded', (event, extension) => {
      this.removeActions(extension.id)
    })
  }

  handleCRXRequest(request: GlobalRequest): GlobalResponse {
    d('%s', request.url)

    try {
      const url = new URL(request.url)
      const { hostname: requestType } = url

      switch (requestType) {
        case 'extension-icon': {
          const tabId = url.searchParams.get('tabId')

          const fragments = url.pathname.split('/')
          // Orivon patch: `?? ''` on all three -- root tsconfig's
          // noUncheckedIndexedAccess (vendor/tsconfig.json does not set it)
          // types an array read as possibly `undefined`; a genuinely short
          // pathname behaves exactly as before (no matching extension/icon
          // found, or NaN into parseInt, same as an `undefined` argument
          // gave previously).
          const extensionId = fragments[1] ?? ''
          const imageSize = parseInt(fragments[2] ?? '', 10)
          const resizeType = parseInt(fragments[3] ?? '', 10) || ResizeType.Up

          const sessionExtensions = this.ctx.session.extensions || this.ctx.session
          const extension = sessionExtensions.getExtension(extensionId)

          let iconDetails: chrome.browserAction.TabIconDetails | undefined

          const action = this.actionMap.get(extensionId)
          if (action) {
            iconDetails = (tabId && action.tabs[tabId]?.icon) || action.icon
          }

          let iconImage

          if (extension && iconDetails) {
            if (typeof iconDetails.path === 'string') {
              const iconAbsPath = resolveExtensionPath(extension, iconDetails.path)
              if (iconAbsPath) iconImage = nativeImage.createFromPath(iconAbsPath)
            } else if (typeof iconDetails.path === 'object') {
              const imagePath = matchSize(iconDetails.path, imageSize, resizeType)
              const iconAbsPath = imagePath && resolveExtensionPath(extension, imagePath)
              if (iconAbsPath) iconImage = nativeImage.createFromPath(iconAbsPath)
            } else if (typeof iconDetails.imageData === 'string') {
              iconImage = nativeImage.createFromDataURL(iconDetails.imageData)
            } else if (typeof iconDetails.imageData === 'object') {
              const imageData = matchSize(iconDetails.imageData as any, imageSize, resizeType)
              iconImage = imageData ? nativeImage.createFromDataURL(imageData) : undefined
            }

            if (iconImage?.isEmpty()) {
              d('crx: icon image is empty', iconDetails)
            }
          }

          if (iconImage) {
            return new Response(new Uint8Array(iconImage.toPNG()), {
              status: 200,
              headers: {
                'Content-Type': 'image/png',
              },
            })
          }

          d('crx: no icon image for %s', extensionId)
          return new Response(null, { status: 400 })
        }
        default: {
          d('crx: invalid request %s', requestType)
          return new Response(null, { status: 400 })
        }
      }
    } catch (e) {
      console.error(e)
      return new Response(null, { status: 500 })
    }
  }

  private getAction(extensionId: string) {
    let action = this.actionMap.get(extensionId)
    if (!action) {
      action = { tabs: {} }
      this.actionMap.set(extensionId, action)
      this.onUpdate()
    }

    return action
  }

  // Orivon patch: same tab-scoped write and onUpdate() broadcast
  // setDetails('BadgeText') makes for an extension calling
  // chrome.action.setBadgeText on itself, for a caller (main-process code,
  // not an extension) that already has the extensionId/tabId/text it wants
  // set and skips the ExtensionEvent/default-value lookup that path needs.
  setBadgeTextFromMain(extensionId: string, tabId: number, text: string): void {
    const action = this.getAction(extensionId)
    const tabAction = action.tabs[tabId] || (action.tabs[tabId] = {})
    tabAction.text = text
    this.onUpdate()
  }

  // TODO: Make private for v4 major release.
  removeActions(extensionId: string) {
    if (this.actionMap.has(extensionId)) {
      this.actionMap.delete(extensionId)
    }

    this.onUpdate()
  }

  // Orivon patch (UPSTREAM.md, patch 32): chrome.runtime.getContexts()'s
  // POPUP entry, for the one extension whose popup is currently open --
  // Chrome allows only one open popup at a time session-wide, matching
  // `this.popup` already being a single field, not a map.
  getOpenPopup(): { extensionId: string; webContents: Electron.WebContents; tabId: number } | undefined {
    if (!this.popup || this.popup.isDestroyed() || this.popupTabId === undefined) return undefined
    const webContents = this.popup.browserWindow?.webContents
    if (webContents === undefined) return undefined
    return { extensionId: this.popup.extensionId, webContents, tabId: this.popupTabId }
  }

  private getPopupUrl(extensionId: string, tabId: number) {
    const action = this.getAction(extensionId)
    const tabPopupValue = action.tabs[tabId]?.popup
    const actionPopupValue = action.popup

    let popupPath: string | undefined

    if (typeof tabPopupValue !== 'undefined') {
      popupPath = tabPopupValue
    } else if (typeof actionPopupValue !== 'undefined') {
      popupPath = actionPopupValue
    }

    if (!popupPath) return undefined

    // Orivon patch: only a URL under THIS extension's own
    // chrome-extension://<extensionId>/ origin is ever returned -- a
    // relative popup path (the common case: default_popup/setPopup almost
    // always set one) resolves against that origin exactly as before, but
    // an ABSOLUTE popupPath naming a different origin (file:, data:, an
    // http(s) page, or another extension's chrome-extension://<id>/) is now
    // refused instead of resolved and returned as-is. PopupView.load()
    // hands whatever this returns straight to a main-process loadURL, with
    // no pass through extension-url-policy.ts at all -- before this patch,
    // any extension whose page called chrome.action.setPopup could point
    // its own toolbar button at an arbitrary URL of its choosing.
    let url: string | undefined
    try {
      const resolved = new URL(popupPath, `chrome-extension://${extensionId}/`)
      if (resolved.protocol === 'chrome-extension:' && resolved.hostname === extensionId) {
        url = resolved.href
      }
    } catch {}

    return url
  }

  // TODO: Make private for v4 major release.
  processExtension(extension: Electron.Extension) {
    const defaultAction = getBrowserActionDefaults(extension)
    if (defaultAction) {
      const action = this.getAction(extension.id)
      Object.assign(action, defaultAction)
    }
  }

  private getState() {
    // Get state without icon data.
    const actions = Array.from(this.actionMap.entries()).map(([id, details]) => {
      const { icon, tabs, ...rest } = details

      const tabsInfo: { [key: string]: any } = {}

      for (const tabId of Object.keys(tabs)) {
        // Orivon patch: `?? {}` -- noUncheckedIndexedAccess, tabId is
        // always one of this same object's own keys, so this fallback
        // never actually applies.
        const { icon, ...rest } = tabs[tabId] ?? {}
        tabsInfo[tabId] = rest
      }

      return {
        id,
        tabs: tabsInfo,
        ...rest,
      }
    })

    const activeTab = this.ctx.store.getActiveTabOfCurrentWindow()
    return { activeTabId: activeTab?.id, actions }
  }

  // Orivon patch (UPSTREAM.md, patch 33):
  // `browser-action.ts`'s own chrome-view preload (`injectBrowserAction`'s
  // `activate()`) calls this EXCLUSIVELY through `crx-msg-remote` -- no
  // extension code, real Chrome or otherwise, is ever meant to reach this
  // handler at all. `event.extension` is the verified signal for which
  // channel a call arrived on: `router.ts`'s `onRemoteMessage` always
  // passes `extensionId: undefined` (so `event.extension` is undefined for
  // EVERY remote call, `setRemoteMessageSenderCheck`'s own
  // `isFromChromeView` gate is what makes that path trustworthy), while
  // `onRouterMessage` (local `crx-msg`) resolves it from the caller's own
  // VERIFIED extension id. Before this fix, a plain extension page could
  // call `browserAction.activate` directly over `crx-msg` with a
  // `details.extensionId`/`details.tabId` of its own choosing -- fields
  // inside the RPC payload, never checked against the caller's real
  // identity -- and open another extension's popup, or fire
  // `browserAction.onClicked` for a tab it has no access to. Refusing
  // every LOCAL call outright closes that route entirely, and is also
  // exactly why `activateClick`'s own invocation recording below only ever
  // runs for a call that reaches here at all: `chrome.action.openPopup()`
  // (no click, no gesture) calls `activateClick` directly, bypassing this
  // handler -- see `openPopup`'s own doc for why that call must still open
  // the popup but never record an invocation.
  private activate({ type, sender, extension }: ExtensionEvent, details: ActivateDetails) {
    if (type != 'frame') return
    if (extension !== undefined) {
      throw new Error(
        `browserAction.activate refused: '${extension.id}' called it directly, not through a real toolbar click.`,
      )
    }
    const { eventType, extensionId, tabId } = details

    d(
      `activate [eventType: ${eventType}, extensionId: '${extensionId}', tabId: ${tabId}, senderId: ${sender?.id}]`,
    )

    switch (eventType) {
      case 'click':
        // `true`: this call only ever reaches here once the guard above
        // has confirmed it came from the real chrome view over
        // crx-msg-remote, i.e. a genuine toolbar click.
        this.activateClick(details, true)
        break
      case 'contextmenu':
        this.activateContextMenu(details)
        break
      default:
        console.debug(`Ignoring unknown browserAction.activate event '${eventType}'`)
    }
  }

  private activateClick(details: ActivateDetails, recordInvocation: boolean = false) {
    const { extensionId, tabId, anchorRect, alignment } = details

    if (this.popup) {
      const toggleExtension = !this.popup.isDestroyed() && this.popup.extensionId === extensionId
      this.popup.destroy()
      this.popup = undefined
      this.popupTabId = undefined
      if (toggleExtension) {
        d('skipping activate to close popup')
        return
      }
    }

    const tab =
      tabId >= 0 ? this.ctx.store.getTabById(tabId) : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) {
      throw new Error(`Unable to get active tab`)
    }

    // Orivon patch (UPSTREAM.md, patch 33): a real toolbar click IS
    // an invocation, whether or not it opens a popup -- both branches below
    // count. `recordInvocation` is false for `openPopup`'s own call (no
    // click, no gesture -- see its own doc) and true only for the one
    // caller that already proved this is a real click (`activate`, above).
    if (recordInvocation) {
      gTabCaptureInvocationRecorder?.(extensionId, tab)
    }

    const popupUrl = this.getPopupUrl(extensionId, tab.id)

    if (popupUrl) {
      const win = this.ctx.store.tabToWindow.get(tab)
      if (!win) {
        throw new Error('Unable to get BrowserWindow from active tab')
      }

      this.popup = new PopupView({
        extensionId,
        session: this.ctx.session,
        parent: win,
        url: popupUrl,
        anchorRect,
        alignment,
      })
      this.popupTabId = tab.id

      d(`opened popup: ${popupUrl}`)

      this.ctx.emit('browser-action-popup-created', this.popup)
    } else {
      d(`dispatching onClicked for ${extensionId}`)

      const tabDetails = this.ctx.store.tabDetailsCache.get(tab.id)
      this.ctx.router.sendEvent(extensionId, 'browserAction.onClicked', tabDetails)
    }
  }

  private activateContextMenu(details: ActivateDetails) {
    const { extensionId, anchorRect } = details

    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    const extension = sessionExtensions.getExtension(extensionId)
    if (!extension) {
      throw new Error(`Unregistered extension '${extensionId}'`)
    }

    const manifest = getExtensionManifest(extension)
    const menu = new Menu()
    const append = (opts: Electron.MenuItemConstructorOptions) => menu.append(new MenuItem(opts))
    const appendSeparator = () => menu.append(new MenuItem({ type: 'separator' }))

    append({
      label: extension.name,
      click: () => {
        const homePageUrl =
          manifest.homepage_url || `https://chrome.google.com/webstore/detail/${extension.id}`
        this.ctx.store.createTab({ url: homePageUrl })
      },
    })

    appendSeparator()

    // TODO(mv3): need to build 'action' menu items?
    const contextMenuItems: MenuItem[] = this.ctx.store.buildMenuItems(
      extensionId,
      'browser_action',
    )
    if (contextMenuItems.length > 0) {
      contextMenuItems.forEach((item) => menu.append(item))
      appendSeparator()
    }

    const optionsPage = manifest.options_page || manifest.options_ui?.page
    const optionsPageUrl = optionsPage ? getExtensionUrl(extension, optionsPage) : undefined

    append({
      label: 'Options',
      enabled: typeof optionsPageUrl === 'string',
      click: () => {
        this.ctx.store.createTab({ url: optionsPageUrl })
      },
    })

    if (process.env.NODE_ENV === 'development' && process.env.DEBUG) {
      append({
        label: 'Remove extension',
        click: () => {
          d(`removing extension "${extension.name}" (${extension.id})`)
          sessionExtensions.removeExtension(extension.id)
        },
      })
    }

    menu.popup({
      x: Math.floor(anchorRect.x),
      y: Math.floor(anchorRect.y + anchorRect.height),
    })
  }

  // chrome.action.openPopup() is a real, legitimate extension API
  // (no toolbar click, no gesture, callable from a service worker) --
  // refusing it is not the fix. What it must never do is count as a
  // tabCapture invocation: `activateClick` below is called directly,
  // skipping `activate`'s own remote-only guard, with NO `recordInvocation`
  // argument (defaults false), the same call shape `activate` itself uses
  // only once it has confirmed a real click.
  private openPopup = (event: ExtensionEvent, options?: chrome.action.OpenPopupOptions) => {
    const window =
      typeof options?.windowId === 'number'
        ? this.ctx.store.getWindowById(options.windowId)
        : this.ctx.store.getCurrentWindow()
    if (!window || window.isDestroyed()) {
      d('openPopup: window %d destroyed', window?.id)
      return
    }

    const activeTab = this.ctx.store.getActiveTabFromWindow(window)
    if (!activeTab) return

    // Orivon patch: `?? 0` -- noUncheckedIndexedAccess types a
    // destructured array element as possibly undefined; getSize() always
    // returns a 2-element tuple, so this fallback never actually applies.
    const [width = 0] = window.getSize()
    const anchorSize = 64

    this.activateClick({
      eventType: 'click',
      extensionId: event.extension.id,
      tabId: activeTab?.id,
      // TODO(mv3): get anchor position
      anchorRect: { x: width - anchorSize, y: 0, width: anchorSize, height: anchorSize },
    })
  }

  private onUpdate() {
    if (this.queuedUpdate) return
    this.queuedUpdate = true
    queueMicrotask(() => {
      this.queuedUpdate = false
      if (this.observers.size === 0) return
      d(`dispatching update to ${this.observers.size} observer(s)`)
      Array.from(this.observers).forEach((observer) => {
        if (!observer.isDestroyed()) {
          observer.send?.('browserAction.update')
        }
      })
    })
  }
}
