// Ambient types for the five virtual electron-chrome-extensions specifiers
// extension-host.ts imports the RUNTIME VALUE of -- src/main/extensions/
// README.md's Design notes say why this boundary exists and how
// electron.vite.config.ts's alias resolves each one for bundling. Kept
// intentionally narrow: only the members extension-host.ts actually calls.
declare module 'orivon:crx-extensions' {
  namespace ElectronChromeExtensionsNS {
    interface CreateTabDetails {
      windowId?: number
      url?: string
      active?: boolean
    }
    interface CreateWindowDetails {
      url?: string | string[]
    }
    interface TabDetails {
      pinned: boolean
      favIconUrl?: string
      [key: string]: unknown
    }
    interface Impl {
      createTab?(details: CreateTabDetails): Promise<[Electron.WebContents, Electron.BaseWindow]>
      selectTab?(tab: Electron.WebContents, window: Electron.BaseWindow): void
      removeTab?(tab: Electron.WebContents, window: Electron.BaseWindow): void
      assignTabDetails?(details: TabDetails, tab: Electron.WebContents): void
      createWindow?(details: CreateWindowDetails): Promise<Electron.BaseWindow>
      removeWindow?(window: Electron.BaseWindow): void
      navigateTab?(tab: Electron.WebContents, url: string): void | Promise<void>
      windowOf?(contents: Electron.WebContents): Electron.BaseWindow | undefined
      activateTabShowing?(url: string): boolean
      extensionContexts?(extensionId: string): Array<{ contextType: 'SIDE_PANEL', contents: Electron.WebContents, windowId: number }>
      menuItemClicked?(extensionId: string, tab: Electron.WebContents): void
    }
    interface Options extends Impl {
      license: 'GPL-3.0' | 'Patron-License-2020-11-19'
      session?: Electron.Session
      preloadPath?: string
    }
  }

  export class ElectronChromeExtensions {
    constructor (opts: ElectronChromeExtensionsNS.Options)
    static fromSession (session: Electron.Session): ElectronChromeExtensions | undefined
    static handleCRXProtocol (session: Electron.Session): void
    addTab (tab: Electron.WebContents, window: Electron.BaseWindow): void
    /** UPSTREAM.md patch 65: a tracked tab now shows in `window`, and stays the same tab. */
    moveTab (tab: Electron.WebContents, window: Electron.BaseWindow): void
    removeTab (tab: Electron.WebContents): void
    /** The items `chrome.contextMenus` gives a right-click in `webContents`. */
    getContextMenuItems (webContents: Electron.WebContents, params: Electron.ContextMenuParams): Electron.MenuItem[]
    selectTab (tab: Electron.WebContents): void
    /** Tells the library no tracked tab is the visible one in `window` right
     * now -- ExtensionStore.clearActiveTab's own doc. */
    clearActiveTab (window: Electron.BaseWindow): void
    /** Fires once a browserAction popup's own view exists, before its page has
     * loaded (browser-action.ts's own activateClick, right after
     * `new PopupView(...)`) -- the only member of this class extension-host.ts
     * listens for, so it is kept to that one event name. `parent`/`destroy`/
     * `isDestroyed` ride alongside `webContents` -- PopupView's own public
     * shape -- so extension-host.ts can close the popup when its tab goes
     * away, not only on the popup's own blur (UPSTREAM.md patch 68). */
    on (event: 'browser-action-popup-created', listener: (popup: {
      webContents: Electron.WebContents
      parent?: Electron.BaseWindow
      isDestroyed (): boolean
      destroy (): void
    }) => void): void
    /** UPSTREAM.md patch 43: this session's ExtensionRouter, for registering
     * an additional main-side API handler the same way this library's own
     * API classes do. */
    getRouter (): ExtensionRouterHandle
    /** UPSTREAM.md patch 44: sets `extensionId`'s badge text for `tabId`
     * directly from main, bypassing the `crx-msg` path a real
     * `chrome.action.setBadgeText` call takes. */
    setBadgeText (extensionId: string, tabId: number, text: string): void
    /** UPSTREAM.md patch 46: the toolbar's actions, without icons (hidden
     * ones left out once `setActionVisibilityCheck` is set). */
    listActions (): Array<{ id: string, title: string, hasPopup: boolean }>
    /** UPSTREAM.md patch 51: every action, pinned or not, with the badge text
     * it shows for `tabId`. */
    listAllActions (tabId?: number): Array<{ id: string, title: string, hasPopup: boolean, badge: string }>
    /** UPSTREAM.md patch 46: a click on `extensionId`'s action for `tab`, from
     * Orivon's own trusted code, counted as an invocation like a real click. */
    activateAction (extensionId: string, tab: Electron.WebContents, anchor: Electron.Rectangle): void
    /** UPSTREAM.md patch 46: the toolbar list changed (public `onUpdate`). */
    notifyActionsChanged (): void
    /** UPSTREAM.md patch 60: fires `chrome.commands.onCommand(name, tab)` in one extension (its worker
     * starts if stopped); `tab` is read through the library's own URL and title filter. */
    sendCommand (extensionId: string, name: string, tab: Electron.WebContents | undefined): void
  }

  /** The subset of `src/browser/router.ts`'s `ExtensionRouter` a caller
   * outside this library needs: registering a handler and sending an event
   * to a listening extension. */
  export interface ExtensionRouterApiEvent {
    readonly type: 'frame' | 'service-worker'
    readonly sender: Electron.WebContents | Electron.ServiceWorkerMain | undefined
    readonly extension: { readonly id: string, readonly manifest: Record<string, unknown> }
  }
  export interface ExtensionRouterHandlerOptions {
    extensionContext?: boolean
    allowRemote?: boolean
    permission?: string
  }
  export interface ExtensionRouterHandle {
    apiHandler (): (
      name: string,
      callback: (event: ExtensionRouterApiEvent, ...args: any[]) => any,
      opts?: ExtensionRouterHandlerOptions
    ) => void
    sendEvent (targetExtensionId: string | undefined, eventName: string, ...args: any[]): void
  }
}

declare module 'orivon:crx-extensions-partition' {
  export function setSessionPartitionResolver (resolver: (partition: string) => Electron.Session): void
}

declare module 'orivon:crx-extensions-router' {
  /** UPSTREAM.md patch 68: the extension whose API call is running, read from inside the callbacks that call
   * makes (`createTab`, `selectTab`), which are not told who asked. */
  export function callingExtensionId (): string | undefined
  interface FrameSenderEvent { type: 'frame', sender: Electron.WebContents }
  interface OtherSenderEvent { type: 'service-worker' }
  type RemoteMessageSenderEvent = FrameSenderEvent | OtherSenderEvent
  export function setRemoteMessageSenderCheck (check: (event: RemoteMessageSenderEvent) => boolean): void

  interface FrameMessageEvent { type: 'frame', senderFrame: Electron.WebFrameMain | null }
  interface ServiceWorkerMessageEvent { type: 'service-worker', serviceWorker: Electron.ServiceWorkerMain }
  type MessageEvent = FrameMessageEvent | ServiceWorkerMessageEvent
  export function setMessageSenderIdCheck (check: (event: MessageEvent, claimedExtensionId: string | undefined) => boolean): void

  /** UPSTREAM.md patch 43: overrides the manifest-permission check
   * `onExtensionMessage` runs for a handler registered with `permission`
   * set, answering from `extensionId`'s ORIGINAL permission record instead
   * of the (stripped) loaded manifest's own `permissions` list. */
  export function setPermissionCheck (check: (extensionId: string, permission: string) => boolean): void

  export function setEventListenerFilter (
    filter: ((extensionId: string, eventName: string, args: readonly unknown[]) => readonly unknown[] | undefined) | undefined
  ): void

  /** True if `url`'s own path matches one of `pages` (an extension's
   * manifest `sandbox.pages`) -- router.ts's own matcher, reused by
   * extension-host.ts's preload-time sandbox-page query so the two ask the
   * identical question. `platform` defaults to `process.platform`;
   * router.ts's own doc says why win32/darwin match case-insensitively. */
  export function isSandboxPageUrl (pages: readonly string[] | undefined, url: string, platform?: NodeJS.Platform): boolean
}

declare module 'orivon:crx-extensions-cookies' {
  /** `manifest` is the calling extension's own loaded `manifest.json`
   * (`event.extension.manifest`), read as `unknown` here so this ambient
   * declaration needs no @types/chrome dependency of its own -- the real
   * check (src/main/extensions/extension-host-access.ts) parses it with
   * readExtensionManifest, the same as an install-time manifest. */
  export function setCookieHostAccessCheck (check: (manifest: unknown, url: string, extensionId: string) => boolean): void
}

declare module 'orivon:crx-extensions-tabs' {
  export function setTabUrlAccessCheck (check: (manifest: unknown, url: string | undefined, extensionId: string, tabId?: number) => boolean): void
  /** Gates chrome.tabs.insertCSS: host access only, never satisfied by the
   * `tabs` permission alone (that one only ever governs url/title/
   * favIconUrl visibility). */
  export function setTabHostAccessCheck (check: (manifest: unknown, url: string | undefined, extensionId: string, tabId?: number) => boolean): void
}

declare module 'orivon:crx-extensions-browser-action' {
  /** Called from activateClick with the tab a toolbar click just happened
   * on -- tab-capture.ts's own activeTab-style invocation check
   * (extension-tab-invocation.ts is the real ledger this ends up in). The
   * real WebContents, not just its id: extension-host.ts's own wiring
   * attaches the navigation/destroy listeners that clear the grant. */
  export function setTabCaptureInvocationRecorder (recorder: (extensionId: string, tab: Electron.WebContents) => void): void
  /** UPSTREAM.md patch 46: which extensions' actions the toolbar list shows
   * (unset: all of them). */
  export function setActionVisibilityCheck (check: (extensionId: string) => boolean): void
  /** UPSTREAM.md patch 46: run once a click is counted, before any popup
   * opens; true means it was handled elsewhere (no popup, no onClicked). */
  export function setActionClickInterceptor (intercept: (extensionId: string, tab: Electron.WebContents) => boolean): void
  /** UPSTREAM.md patch 50: builds the right-click menu of a toolbar action;
   * `extensionItems` are the extension's own `contextMenus` entries for it. */
  export function setActionMenuBuilder (
    builder: ((extensionId: string, extensionItems: Electron.MenuItem[]) => Array<Electron.MenuItemConstructorOptions | Electron.MenuItem>) | undefined
  ): void

  /** Where a popup goes: the toolbar rectangle it opens from, which side of it, and its size. */
  export interface PopupPlacement {
    anchorRect: Electron.Rectangle
    alignment?: string | undefined
    size: { width: number, height: number }
  }
  /** UPSTREAM.md patch 68: what a popup, a view the library builds and never attaches itself,
   * needs from its window. Bounds are in the window's content coordinates. */
  export interface PopupHost {
    mount (parent: Electron.BaseWindow, view: Electron.WebContentsView): void
    unmount (parent: Electron.BaseWindow, view: Electron.WebContentsView): void
    place (parent: Electron.BaseWindow, view: Electron.WebContentsView, placement: PopupPlacement): void
    /** True while a loss of focus must not close the popup: the embedder is moving focus for this popup's
     * own extension. */
    keepOpenOnBlur? (popup: { extensionId: string, parent: Electron.BaseWindow }): boolean
    /** How long that hand-over lasts; the popup takes the keyboard back after it. */
    focusHandoverMs?: number | undefined
    /** The page in front of `parent` while its main frame has a navigation that has not committed or
     * failed: the popup stays open through the blur that commit causes. */
    navigationInFlight? (parent: Electron.BaseWindow): Electron.WebContents | undefined
  }
  export function setPopupHost (host: PopupHost | undefined): void
  /** UPSTREAM.md patch 69: where `chrome.action.openPopup()` anchors the popup, in `window`'s
   * content coordinates; `undefined` for the window's top-right corner. */
  export function setOpenPopupAnchor (
    anchor: ((extensionId: string, window: Electron.BaseWindow) => Promise<Electron.Rectangle | undefined>) | undefined
  ): void
}

declare module 'orivon:crx-extensions-tab-capture' {
  export function setTabCaptureInvocationCheck (check: (extensionId: string, tabId: number) => boolean): void
  /** True refuses the capture outright -- a granted app's own tab
   * (extension-host.ts wires this to `broker.app.hasGrantsSync`, the same
   * predicate shell-services.ts's own DevTools prompt uses). */
  export function setTabCaptureAppRefusalCheck (check: (tab: Electron.WebContents) => boolean): void
  /** Called once per successful getMediaStreamId, so permission-gate.ts's
   * own 'media' carve-out (tab-capture-grants.ts) knows to allow it, for
   * this exact (extensionId, targetTabId) pair -- never extension alone, so
   * one tab's redemption never marks a different tab the same extension is
   * also capturing. */
  export function setTabCaptureGrantRecorder (recorder: (extensionId: string, targetTabId: number) => void): void
  /** True once permission-gate.ts has actually allowed a 'media' request
   * for this exact (extensionId, targetTabId) pair
   * (tab-capture-grants.ts's wasTabCaptureGrantConsumed) -- the real "did a
   * capture actually start for THIS tab" signal the safety net in
   * tab-capture.ts checks once, at the minted id's own validity window. */
  export function setTabCaptureConsumedCheck (check: (extensionId: string, targetTabId: number) => boolean): void
}
