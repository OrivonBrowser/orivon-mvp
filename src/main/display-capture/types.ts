// The shapes the display-capture gate, its picker, its indicators and the app media grants share. Pure: no value
// from `electron`, so every part is unit-tested with fakes. ADR-0055 is the decision; README.md says who owns what.
import type { WebContents } from 'electron'

/** What the person can pick: a tab of this process, an application window, or a whole screen. */
export type DisplaySurfaceKind = 'tab' | 'window' | 'screen'

/**
 * The page's `getDisplayMedia` options that Electron never passes to main. The preload's wrapper reads them from
 * the page's call and main validates every field, so they steer the picker and decide nothing.
 */
export interface DisplayHints {
  readonly displaySurface?: 'browser' | 'window' | 'monitor'
  readonly preferCurrentTab?: boolean
  readonly selfBrowserSurface?: 'include' | 'exclude'
  readonly systemAudio?: 'include' | 'exclude'
  readonly monitorTypeSurfaces?: 'include' | 'exclude'
}

/** A page's request to share, once main has checked which tab's top frame asked and that it may ask. */
export interface DisplayRequest {
  readonly tab: WebContents
  /** The asking frame's committed origin, read in main, never from the page. */
  readonly origin: string
  /** A registered app's origin: the picker names the app. */
  readonly isApp: boolean
  /** The page asked for audio as well. */
  readonly audio: boolean
  readonly hints: DisplayHints
}

/** What the person picked. `label` is what the indicators show: a tab's title, a window's title, a screen's name. */
export type DisplayChoice =
  | { readonly kind: 'tab', readonly tab: WebContents, readonly audio: boolean, readonly label: string }
  | {
    readonly kind: 'window' | 'screen'
    /** A `desktopCapturer` source, as the display handler hands it to Electron. */
    readonly source: { readonly id: string, readonly name: string }
    /** System audio, which Electron captures only on Windows. */
    readonly systemAudio: boolean
    readonly label: string
  }

/** The picker. Resolves null for every way out but Share: cancel, Escape, a navigation, a closed tab, the signal. */
export type ChooseDisplaySource = (request: DisplayRequest, signal: AbortSignal) => Promise<DisplayChoice | null>

/** The three app media kinds of `Capabilities.media` (ADR-0032, ADR-0055). */
export type AppMediaKind = 'media.camera' | 'media.microphone' | 'media.screen'

/** A registered app's media grants, as the gate reads them. */
export interface AppMediaGrants {
  /** Granted now. Synchronous, for the check handler; never asks. */
  held: (origin: string, kind: AppMediaKind) => boolean
  /** Granted, or asked now in the tab's panel when the manifest declares the kind and no grant is held. False when undeclared. */
  request: (tab: WebContents, origin: string, kind: AppMediaKind) => Promise<boolean>
}

/** A share the person started and that has not ended. */
export interface ActiveShare {
  readonly id: string
  /** The tab whose page receives the capture. */
  readonly requester: WebContents
  readonly origin: string
  readonly kind: DisplaySurfaceKind
  readonly label: string
  /** The tab being shown, for a tab share. */
  readonly captured?: WebContents
  readonly audio: boolean
  readonly startedAt: number
}

/** The running shares, for the indicators and Stop. */
export interface ShareRegistry {
  list: () => readonly ActiveShare[]
  forRequester: (contents: WebContents) => readonly ActiveShare[]
  forCaptured: (contents: WebContents) => readonly ActiveShare[]
  /** The person picked this tab for a share that has not started: its view must stay in the window until it does or the pick lapses. */
  capturePending: (contents: WebContents) => boolean
  /** Called after any share starts or ends; returns the unsubscribe. */
  onChange: (listener: () => void) => () => void
  /** Ends the tracks the page was handed and tells the page they ended. A share already gone is ignored. */
  stop: (id: string) => void
}
