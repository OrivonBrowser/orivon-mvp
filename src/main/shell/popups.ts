// window.open() and target=_blank in a browser whose windows are tabs. A
// popup the page can talk to (window.open returning a real window, with
// `opener` set) is Chromium's own new webContents adopted into a tab; any
// other open is an ordinary new tab. README.md's Design notes say why a
// popup keeps its opener's session.
import { WebContentsView } from 'electron'
import type { HandlerDetails, WebContents, WebPreferences, WindowOpenHandlerResponse } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'

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
  if (seversOpener(details.features)) return 'new-tab'
  if (targetPartition === opener.partition) return 'adopt'
  // Crossing sessions: only a page that asked for a popup window, or a blank
  // one it will fill, is waiting on the opener link. A link or a plain
  // window.open(url) loads in the right session from its first request.
  return details.disposition === 'new-window' || details.url === 'about:blank' ? 'adopt' : 'new-tab'
}

export interface PopupHost {
  atCapacity: () => boolean
  openTab: (url: string) => void
  /** `url` is what the popup was opened at, for anything the tab decides from it. */
  adoptPopup: (view: WebContentsView, partition: string | undefined, url: string) => void
  /** The session a tab opened at `url` would get. */
  partitionFor: (url: string) => string | undefined
  /** The webPreferences a tab opened at `url` would get, without a
   * partition: Chromium puts a popup in its opener's session regardless. */
  webPreferencesFor: (url: string) => WebPreferences
}

/** The popup's webContents, which Chromium has already created. Passed in
 * the options Electron hands `createWindow`, though its type omits it. */
function guestOf (options: object): WebContents {
  return (options as { webContents: WebContents }).webContents
}

export function windowOpenHandler (
  host: PopupHost,
  opener: () => PopupOpener
): (details: HandlerDetails) => WindowOpenHandlerResponse {
  return (details) => {
    if (host.atCapacity()) return { action: 'deny' }
    const from = opener()
    if (routePopup(details, from, host.partitionFor(details.url)) === 'new-tab') {
      host.openTab(details.url)
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
        const view = new WebContentsView({ webContents: guestOf(options), ...(options.webPreferences !== undefined ? { webPreferences: options.webPreferences } : {}) })
        host.adoptPopup(view, from.partition, details.url)
        return view.webContents
      }
    }
  }
}
