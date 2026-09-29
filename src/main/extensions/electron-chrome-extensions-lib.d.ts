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
    removeTab (tab: Electron.WebContents): void
    selectTab (tab: Electron.WebContents): void
    /** Tells the library no tracked tab is the visible one in `window` right
     * now -- ExtensionStore.clearActiveTab's own doc. */
    clearActiveTab (window: Electron.BaseWindow): void
    /** Fires once a browserAction popup's own BrowserWindow exists, before
     * its page has loaded (browser-action.ts's own activateClick, right
     * after `new PopupView(...)`) -- the only member of this class
     * extension-host.ts listens for, so it is kept to that one event name.
     * `parent`/`destroy`/`isDestroyed` added alongside `browserWindow` --
     * PopupView's own public shape -- so extension-host.ts can close the
     * popup when the PARENT window regains focus, not only when the
     * popup's own `blur` fires. */
    on (event: 'browser-action-popup-created', listener: (popup: {
      browserWindow?: { webContents: Electron.WebContents }
      parent?: Electron.BaseWindow
      isDestroyed (): boolean
      destroy (): void
    }) => void): void
  }
}

declare module 'orivon:crx-extensions-partition' {
  export function setSessionPartitionResolver (resolver: (partition: string) => Electron.Session): void
}

declare module 'orivon:crx-extensions-router' {
  interface FrameSenderEvent { type: 'frame', sender: Electron.WebContents }
  interface OtherSenderEvent { type: 'service-worker' }
  type RemoteMessageSenderEvent = FrameSenderEvent | OtherSenderEvent
  export function setRemoteMessageSenderCheck (check: (event: RemoteMessageSenderEvent) => boolean): void

  interface FrameMessageEvent { type: 'frame', senderFrame: Electron.WebFrameMain | null }
  interface ServiceWorkerMessageEvent { type: 'service-worker', serviceWorker: Electron.ServiceWorkerMain }
  type MessageEvent = FrameMessageEvent | ServiceWorkerMessageEvent
  export function setMessageSenderIdCheck (check: (event: MessageEvent, claimedExtensionId: string | undefined) => boolean): void

  export function setEventListenerFilter (
    filter: ((extensionId: string, eventName: string, args: readonly unknown[]) => readonly unknown[] | undefined) | undefined
  ): void
}

declare module 'orivon:crx-extensions-cookies' {
  /** `manifest` is the calling extension's own loaded `manifest.json`
   * (`event.extension.manifest`), read as `unknown` here so this ambient
   * declaration needs no @types/chrome dependency of its own -- the real
   * check (src/main/extensions/extension-host-access.ts) parses it with
   * readExtensionManifest, the same as an install-time manifest. */
  export function setCookieHostAccessCheck (check: (manifest: unknown, url: string) => boolean): void
}

declare module 'orivon:crx-extensions-tabs' {
  export function setTabUrlAccessCheck (check: (manifest: unknown, url: string | undefined) => boolean): void
  /** Gates chrome.tabs.insertCSS: host access only, never satisfied by the
   * `tabs` permission alone (that one only ever governs url/title/
   * favIconUrl visibility). */
  export function setTabHostAccessCheck (check: (manifest: unknown, url: string | undefined) => boolean): void
}

declare module 'orivon:crx-extensions-browser-action' {
  /** Called from activateClick with the tab a toolbar click just happened
   * on -- tab-capture.ts's own activeTab-style invocation check
   * (extension-tab-invocation.ts is the real ledger this ends up in). The
   * real WebContents, not just its id: extension-host.ts's own wiring
   * attaches the navigation/destroy listeners that clear the grant. */
  export function setTabCaptureInvocationRecorder (recorder: (extensionId: string, tab: Electron.WebContents) => void): void
}

declare module 'orivon:crx-extensions-tab-capture' {
  export function setTabCaptureInvocationCheck (check: (extensionId: string, tabId: number) => boolean): void
  /** True refuses the capture outright -- a granted app's own tab
   * (extension-host.ts wires this to `broker.app.hasGrantsSync`, the same
   * predicate shell-services.ts's own DevTools prompt uses). */
  export function setTabCaptureAppRefusalCheck (check: (tab: Electron.WebContents) => boolean): void
  /** Called once per successful getMediaStreamId, so permission-gate.ts's
   * own 'media' carve-out (tab-capture-grants.ts) knows to allow it. */
  export function setTabCaptureGrantRecorder (recorder: (extensionId: string) => void): void
}
