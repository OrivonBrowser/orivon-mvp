// The screen over a tab whose protocol page is loading: a title, the address and a line of detail, drawn over the whole
// page area. The tab's watcher asks for it with the address; this wording comes from the protocol's descriptor.
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import type { OverlayDef, OverlayHandler, OverlayWindow } from '../overlays/overlay-types.js'
import { slotClosed } from '../overlays/tab-slots.js'
import { ADDRESS_LIMIT } from '../sad-tab/sad-tab-text.js'
import { LOADING_SCREEN_OVERLAY } from './loading-screen-watch.js'

export interface LoadingScreenView {
  readonly title: string
  /** Empty when the protocol gives none. */
  readonly detail: string
  /** The address as the person reads it (`ipfs://<name>/`), cut to ADDRESS_LIMIT. */
  readonly address: string
}

/** The longest address taken from the payload: a page can navigate to a URL of any length. */
const URL_LIMIT = 4096

function asUrl (payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const keys = Object.keys(payload)
  const { url } = payload as { url?: unknown }
  return keys.length === 1 && typeof url === 'string' && url.length <= URL_LIMIT ? url : undefined
}

export const loadingScreenOverlay: OverlayDef = {
  name: LOADING_SCREEN_OVERLAY,
  placement: { kind: 'pane' },
  surface: 'page',
  // It never takes the keyboard from the address bar or the page it covers.
  focus: 'never',
  layer: 'cover',
  closeOn: { blur: false, tabSwitch: true, navigation: false, layout: false },
  keep: 'warm',
  attach: ({ window, close }: OverlayWindow): OverlayHandler => ({
    show: (payload): LoadingScreenView | undefined => {
      const url = asUrl(payload)
      const screen = url === undefined ? undefined : BUILTIN_ADDRESSES.loadingScreenFor(url)
      if (url === undefined || screen === undefined) { close(); return undefined }
      return { title: screen.title, detail: screen.detail ?? '', address: BUILTIN_ADDRESSES.displayUrl(url).slice(0, ADDRESS_LIMIT) }
    },
    request: () => undefined,
    closed: (reason) => { slotClosed(window, LOADING_SCREEN_OVERLAY, reason) }
  })
}
