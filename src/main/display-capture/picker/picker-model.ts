// What the screen-share picker offers and how the page's hints steer it. Pure: no `electron` import, so every branch
// is unit-tested with fakes. The page is only ever given ids, labels and data URLs built here.
import type { DisplayHints, DisplaySurfaceKind } from '../types.js'
import type { TabState } from '../../shell/tab-types.js'

export type PickerSegment = DisplaySurfaceKind

/** How a segment that lists desktop sources behaves on this system. */
export type SegmentMode =
  /** The sources are listed in the picker, with thumbnails. */
  | 'list'
  /** The desktop portal lists them in its own dialog, so the picker shows one card that opens it (Linux Wayland). */
  | 'portal'
  /** The system has not let Orivon record the screen (macOS), so there is nothing to list. */
  | 'permission'

export interface PickerPlatform {
  readonly os: NodeJS.Platform
  /** A native Wayland session: listing windows or screens there asks the person through the desktop portal. */
  readonly wayland: boolean
  /** macOS answers that Orivon may not record the screen. */
  readonly screenDenied: boolean
}

/** What one card draws. `id` is random per question and names the card in a share: it carries no webContents or source id. */
export interface PickerCard {
  readonly id: string
  readonly label: string
  readonly sub: string | null
  /** A JPEG data URL, or null while there is none. */
  readonly thumb: string | null
  /** A favicon or a window's icon, as a data URL. */
  readonly icon: string | null
  /** The tab that asked, offered first. */
  readonly self: boolean
}

export interface PickerAudio {
  /** The page asked for audio, so a tab share may carry the tab's. */
  readonly tab: boolean
  /** The page asked for audio and the system can capture it (Windows only). */
  readonly system: boolean
  readonly systemDefault: boolean
}

/** The segments offered: the page may ask for no screens. */
export function segmentsFor (hints: DisplayHints): PickerSegment[] {
  return hints.monitorTypeSurfaces === 'exclude' ? ['tab', 'window'] : ['tab', 'window', 'screen']
}

/** The segment the picker opens on: the surface the page named, or this tab when it prefers the current tab; otherwise tabs. */
export function defaultSegment (hints: DisplayHints, segments: readonly PickerSegment[]): PickerSegment {
  const wanted: PickerSegment = hints.preferCurrentTab === true && hints.selfBrowserSurface !== 'exclude'
    ? 'tab'
    : hints.displaySurface === 'window' ? 'window' : hints.displaySurface === 'monitor' ? 'screen' : 'tab'
  return segments.includes(wanted) ? wanted : 'tab'
}

export function segmentMode (platform: PickerPlatform): SegmentMode {
  if (platform.os === 'darwin' && platform.screenDenied) return 'permission'
  return platform.os === 'linux' && platform.wayland ? 'portal' : 'list'
}

/** `audio` is whether the page asked for it. */
export function audioPlan (audio: boolean, hints: DisplayHints, platform: PickerPlatform): PickerAudio {
  return { tab: audio, system: audio && platform.os === 'win32', systemDefault: hints.systemAudio === 'include' }
}

/** Whether a tab may be offered: an ordinary website or app page that is awake. Orivon's own pages, extension pages and sleeping tabs never are. */
export function isPickableTab (tab: TabState): boolean {
  return !tab.isInternal && !tab.isNewTab && tab.sleeping !== true && tab.crashed === null && /^https?:\/\//i.test(tab.url)
}

/** A card's text is cut so a page cannot make a card enormous. */
export const MAX_CARD_TEXT = 200
export const cardText = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, MAX_CARD_TEXT)

/** One thumbnail over this many characters is left out. */
export const MAX_THUMB_CHARS = 64 * 1024
/** Thumbnails and icons of one list, together, before the rest go without. */
export const THUMB_BUDGET_CHARS = 1536 * 1024
/** An icon over this many characters is left out. */
export const MAX_ICON_CHARS = 16 * 1024

const isImageUrl = (url: string | null): url is string => url !== null && url.startsWith('data:image/')

/** Keeps each image only when it is an image data URL within its own cap and the list's budget, in card order. */
export function budgetImages (cards: readonly PickerCard[]): PickerCard[] {
  let budget = THUMB_BUDGET_CHARS
  const take = (url: string | null, cap: number): string | null => {
    if (!isImageUrl(url) || url.length > cap || url.length > budget) return null
    budget -= url.length
    return url
  }
  return cards.map((card) => ({ ...card, thumb: take(card.thumb, MAX_THUMB_CHARS), icon: take(card.icon, MAX_ICON_CHARS) }))
}

/** The one card of a segment the desktop portal answers for. */
export function portalCardText (segment: 'window' | 'screen'): { label: string, sub: string } {
  return segment === 'window'
    ? { label: 'Choose a window in the system dialog', sub: 'Your system asks which window once you press Share.' }
    : { label: 'Choose a screen in the system dialog', sub: 'Your system asks which screen once you press Share.' }
}

/** Far above the ids the capture library numbers its own sources with. */
const PORTAL_ID_BASE = 2 ** 40
let portalIds = 0

/** A source id the capture has never seen, so it has no stored pick to restore and asks the system dialog itself; each call is new because a reused id would restore the last pick without asking. See README.md's Design notes. */
export function portalSourceId (segment: 'window' | 'screen'): string {
  portalIds += 1
  return `${segment}:${String(PORTAL_ID_BASE + portalIds)}:0`
}

export const PERMISSION_TEXT = 'Orivon needs Screen Recording permission to list your windows and screens.'
export const SCREEN_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
