// Ambient types for the three vendored electron-chrome-extensions entry
// points extension-host.ts needs the RUNTIME VALUE of: the
// ElectronChromeExtensions class (src/browser/index.ts) and the partition
// and router sender-check setters (src/browser/partition.ts,
// src/browser/router.ts).
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
}
