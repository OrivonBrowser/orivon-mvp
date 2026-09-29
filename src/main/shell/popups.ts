// window.open() and target=_blank in a browser whose windows are tabs. A
// popup the page can talk to (window.open returning a real window, with
// `opener` set) is Chromium's own new webContents adopted into a tab; any
// other open is an ordinary new tab. README.md's Design notes say why a
// popup keeps its opener's session.
import { WebContentsView } from 'electron'
import type { HandlerDetails, WebContents, WebPreferences, WindowOpenHandlerResponse } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'

export type PopupRoute = 'adopt' | 'new-tab'

export interface PopupOpener {
  readonly url: string
  readonly partition: string | undefined
}

/** A window feature that severs the opener, matched as a whole name. */
function seversOpener (features: string): boolean {
  return features.split(',').some((feature) => {
    const name = feature.split('=')[0]?.trim().toLowerCase()
    return name === 'noopener' || name === 'noreferrer'
  })
}

/** `targetPartition` is the session a tab opened at `details.url` would get
 * on its own. A popup Chromium creates always shares its opener's. */
export function routePopup (
  details: Pick<HandlerDetails, 'url' | 'features' | 'disposition'>,
  opener: PopupOpener,
  targetPartition: string | undefined
): PopupRoute {
  // A blob: URL resolves only in the storage partition that minted it, so
  // a fresh tab in any session would load nothing.
  if (details.url.startsWith('blob:')) {
    const minter = originFromUrl(details.url.slice('blob:'.length))
    return minter !== null && minter === originFromUrl(opener.url) ? 'adopt' : 'new-tab'
  }
  // Chromium cannot load a protocol's address itself; only a new tab turns it into the URL serving it.
  if (seversOpener(details.features) || BUILTIN_ADDRESSES.servedUrl(details.url) !== undefined) return 'new-tab'
  if (targetPartition === opener.partition) return 'adopt'
  // An isolated app's pinned bundle is served only in its own session.
  // Adopted anywhere else, its origin would run whatever the network sends,
  // with its grants.
  if (targetPartition !== undefined) return 'new-tab'
  // Out onto the open web: only a page that asked for a popup window, or a
  // blank one it will fill, is waiting on the opener link. A link or a plain
  // window.open(url) loads in the right session from its first request.
  return details.disposition === 'new-window' || details.url === 'about:blank' ? 'adopt' : 'new-tab'
}

export interface PopupHost {
  atCapacity: () => boolean
  /** `active` false opens the tab behind the current one: a middle click or a plain ctrl+click. */
  openTab: (url: string, active: boolean) => void
  /** `url` is what the popup was opened at, for anything the tab decides from it.
   * `active` -- see `openTab`'s own doc. */
  adoptPopup: (view: WebContentsView, partition: string | undefined, url: string, active: boolean) => void
  /** The session a tab opened at `url` would get. */
  partitionFor: (url: string) => string | undefined
  /** The webPreferences a tab opened at `url` would get, without a
   * partition: Chromium puts a popup in its opener's session regardless. */
  webPreferencesFor: (url: string) => WebPreferences
}

/** The webContents Chromium already built for the open, if any -- present in the `options`
 * `createWindow` receives, though its type omits the field entirely. Measured against Electron
 * 44: a modifier-key open (middle click, ctrl+click, shift+click, ctrl+shift+click, on any link
 * regardless of `target`) never carries one, whatever its disposition; only a renderer-driven
 * open a script holds a `Window` handle to -- window.open(), or a plain click on target=_blank --
 * does. */
function guestOf (options: object): WebContents | undefined {
  return (options as { webContents?: WebContents }).webContents
}

export function windowOpenHandler (
  host: PopupHost,
  opener: () => PopupOpener
): (details: HandlerDetails) => WindowOpenHandlerResponse {
  return (details) => {
    if (host.atCapacity()) return { action: 'deny' }
    const from = opener()
    // Every browser opens a middle click or a plain ctrl+click behind the current tab.
    const active = details.disposition !== 'background-tab'
    if (routePopup(details, from, host.partitionFor(details.url)) === 'new-tab') {
      host.openTab(details.url, active)
      return { action: 'deny' }
    }
    return {
      action: 'allow',
      // A tab outlives the tab that opened it, as it does in every browser.
      outlivesOpener: true,
      overrideBrowserWindowOptions: { webPreferences: host.webPreferencesFor(details.url) },
      createWindow: (options) => {
        // webPreferences again, not only webContents: adopting without them
        // drops the preload, measured against Electron 44, and the popup
        // then has no orivon surface at all.
        const webPreferences = options.webPreferences !== undefined ? { webPreferences: options.webPreferences } : {}
        const guest = guestOf(options)
        // No guest (guestOf's own doc): build the view ourselves, the way TabFactory.content()
        // would for an ordinary tab, and load it -- Electron never navigates a view constructed
        // here on its own. Given `webContents: undefined` directly instead, WebContentsView's
        // constructor throws synchronously, and this process has no top-level catch for that
        // (index.ts's `exitOnUncaught` turns any uncaught exception into a full exit, by design).
        const view = guest === undefined ? new WebContentsView(webPreferences) : new WebContentsView({ webContents: guest, ...webPreferences })
        if (guest === undefined) {
          void view.webContents.loadURL(details.url).catch((error) => {
            console.error('[orivon] a modifier-click tab failed to load its first URL:', error)
          })
        }
        host.adoptPopup(view, from.partition, details.url, active)
        return view.webContents
      }
    }
  }
}
