// The screen over a tab whose protocol page is loading: a title, the address and a line of detail, drawn over the whole
// page area. The tab's watcher asks for it with the address; this wording comes from the protocol's descriptor. A first
// visit to an app (../app-setup/) asks with its own words instead, for an address no protocol has a screen for.
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
  /** Something is still moving: the page draws its slim bar. False once a sheet explains why nothing will. */
  readonly busy: boolean
}

/** Words a caller brings for an address no protocol words a screen for. */
interface SetupText { readonly title: string, readonly detail: string, readonly busy: boolean }

const TEXT_TITLE_LIMIT = 160
const TEXT_DETAIL_LIMIT = 300

/** The longest address taken from the payload: a page can navigate to a URL of any length. */
const URL_LIMIT = 4096

function asText (value: unknown): SetupText | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { title, detail, busy } = value as { title?: unknown, detail?: unknown, busy?: unknown }
  if (Object.keys(value).length !== 3 || typeof title !== 'string' || typeof detail !== 'string' || typeof busy !== 'boolean') return undefined
  return title.length <= TEXT_TITLE_LIMIT && detail.length <= TEXT_DETAIL_LIMIT ? { title, detail, busy } : undefined
}

/** `{ url }`, worded by the protocol; or `{ url, text }`, worded by the caller. Anything else is refused whole. */
function asAsk (payload: unknown): { url: string, text: SetupText | undefined } | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const keys = Object.keys(payload)
  const { url, text } = payload as { url?: unknown, text?: unknown }
  if (typeof url !== 'string' || url.length > URL_LIMIT) return undefined
  if (keys.length === 1) return { url, text: undefined }
  if (keys.length !== 2 || !Object.hasOwn(payload, 'text')) return undefined
  const words = asText(text)
  return words === undefined ? undefined : { url, text: words }
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
      const ask = asAsk(payload)
      const screen = ask === undefined ? undefined : ask.text ?? BUILTIN_ADDRESSES.loadingScreenFor(ask.url)
      if (ask === undefined || screen === undefined) { close(); return undefined }
      return { title: screen.title, detail: screen.detail ?? '', address: BUILTIN_ADDRESSES.displayUrl(ask.url).slice(0, ADDRESS_LIMIT), busy: ask.text?.busy ?? true }
    },
    request: () => undefined,
    closed: (reason) => { slotClosed(window, LOADING_SCREEN_OVERLAY, reason) }
  })
}
