// Ambient types for the vendored electron-chrome-extensions entry points
// extension-host.ts and extensions-dnr.ts/dnr-api.ts need the RUNTIME VALUE
// of: the ElectronChromeExtensions class (src/browser/index.ts) and the
// partition/router sender-check and permission-check setters
// (src/browser/partition.ts, src/browser/router.ts).
//
// Importing those files' real paths pulls their whole tree (electron-vite
// serves this out/main/index.js on that same bundle) into THIS project's
// stricter tsconfig (verbatimModuleSyntax, exactOptionalPropertyTypes,
// noImplicitOverride) -- measured, ~66 diagnostics across 16 files that
// satisfy vendor/tsconfig.json's own, deliberately looser settings
// (ADR-0043: "its TypeScript checks under vendor/tsconfig.json"). Patching
// every one would mean reformatting most of the vendored tree, the opposite
// of what ADR-0043 asks for.
//
// electron.vite.config.ts's `main.resolve.alias` maps the three virtual
// specifiers below to the real vendor files for BUNDLING (Rollup follows
// the alias to the real source and compiles it in, same as any other
// import); nothing here changes at runtime. For TYPE CHECKING, tsc cannot
// resolve a virtual specifier to any real file, so it falls back to this
// ambient declaration instead of opening the real one -- the boundary this
// file exists to draw. Kept intentionally narrow: only the members
// extension-host.ts actually calls.
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
      license: 'GPL-3.0' | 'Patron-License-2025-10-08'
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
    /** UPSTREAM.md patch 15: this session's ExtensionRouter, for registering
     * an additional main-side API handler the same way this library's own
     * API classes do. */
    getRouter (): ExtensionRouterHandle
  }

  /** The subset of `src/browser/router.ts`'s `ExtensionRouter` a caller
   * outside this library needs: registering a handler and sending an event
   * to a listening extension. */
  export interface ExtensionRouterApiEvent {
    readonly extension: { readonly id: string }
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
  interface FrameSenderEvent { type: 'frame', sender: Electron.WebContents }
  interface OtherSenderEvent { type: 'service-worker' }
  type RemoteMessageSenderEvent = FrameSenderEvent | OtherSenderEvent
  export function setRemoteMessageSenderCheck (check: (event: RemoteMessageSenderEvent) => boolean): void

  interface FrameMessageEvent { type: 'frame', senderFrame: Electron.WebFrameMain | null }
  interface ServiceWorkerMessageEvent { type: 'service-worker', serviceWorker: Electron.ServiceWorkerMain }
  type MessageEvent = FrameMessageEvent | ServiceWorkerMessageEvent
  export function setMessageSenderIdCheck (check: (event: MessageEvent, claimedExtensionId: string | undefined) => boolean): void

  /** UPSTREAM.md patch 15: overrides the manifest-permission check
   * `onExtensionMessage` runs for a handler registered with `permission`
   * set, answering from `extensionId`'s ORIGINAL permission record instead
   * of the (stripped) loaded manifest's own `permissions` list. */
  export function setPermissionCheck (check: (extensionId: string, permission: string) => boolean): void
}
