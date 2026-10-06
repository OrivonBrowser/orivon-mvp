// What the permission prompt and its review bubble say, and the data each
// shows. Pure: main builds it from its own records and the page only draws it,
// so the page never names a site or a kind it did not get from here.
import { formatOriginForDisplay } from '../consent/grant-prompt-origin.js'
import { siteKindById, type SiteKind, type SiteValue } from './kinds.js'

/** One line of a prompt: the kinds it covers (camera and microphone share one) and what the site wants. */
export interface AskLine { readonly kinds: readonly SiteKind[], readonly text: string }

export interface AskView {
  readonly mode: 'ask'
  /** Which question this is: the answer names it, and main accepts it only for the one on screen. */
  readonly id: string
  /** The site, as the person should read it. */
  readonly origin: string
  readonly lines: readonly AskLine[]
  /** Location is asked for but answered "unavailable": the prompt says so before the person allows it. */
  readonly locationNote: string | null
  /** The answer is forgotten when this window closes. */
  readonly privateNote: string | null
  /** How long the buttons are drawn as not ready: main refuses an answer that soon after the show. */
  readonly guardMs: number
}

export interface ReviewRow {
  readonly kind: SiteKind
  readonly label: string
  /** What is in force for this site: `ask` when it has no answer of its own. */
  readonly value: SiteValue
  /** The default for the kind is to block, so "Ask" would change nothing. */
  readonly askOffered: boolean
  /** The kind keeps an allow; screen sharing is asked each time and only ever stores a block. */
  readonly allowOffered: boolean
}

export interface ReviewView {
  readonly mode: 'review'
  readonly origin: string
  readonly rows: readonly ReviewRow[]
  /** Site settings has a page to open. */
  readonly settingsLink: boolean
}

export const LOCATION_NOTE = 'Orivon has no location service yet. If you allow this, your choice is kept, but the site is still told it cannot have your position.'
export const PRIVATE_NOTE = 'Forgotten when this private window closes.'

const WANTS: Readonly<Partial<Record<SiteKind, string>>> = {
  camera: 'wants to use your camera',
  microphone: 'wants to use your microphone',
  clipboardRead: 'wants to see text and images you copied',
  location: 'wants to know your location',
  midi: 'wants to use your MIDI devices',
  idle: 'wants to know when you are away from this computer',
  windowManagement: 'wants to place windows across your screens',
  notifications: 'wants to show notifications',
  autoDownloads: 'wants to download several files'
}

const MIDI_SYSEX = 'wants to control and reprogram your MIDI devices'
const BOTH_DEVICES = 'wants to use your camera and microphone'

/** What the site wants, one line per thing, with the camera and the microphone said together. */
export function askLines (kinds: readonly SiteKind[], sysex: boolean): AskLine[] {
  const lines: AskLine[] = []
  if (kinds.includes('camera') && kinds.includes('microphone')) lines.push({ kinds: ['camera', 'microphone'], text: BOTH_DEVICES })
  for (const kind of kinds) {
    if (lines.some((line) => line.kinds.includes(kind))) continue
    const label = siteKindById(kind)?.label.toLowerCase() ?? 'something'
    lines.push({ kinds: [kind], text: kind === 'midi' && sysex ? MIDI_SYSEX : WANTS[kind] ?? `wants to use ${label}` })
  }
  return lines
}

export function askView (id: string, origin: string, kinds: readonly SiteKind[], sysex: boolean, isPrivate: boolean, guardMs: number): AskView {
  return {
    mode: 'ask',
    id,
    origin: formatOriginForDisplay(origin),
    lines: askLines(kinds, sysex),
    locationNote: kinds.includes('location') ? LOCATION_NOTE : null,
    privateNote: isPrivate ? PRIVATE_NOTE : null,
    guardMs
  }
}

export function reviewView (origin: string, rows: readonly ReviewRow[], settingsLink: boolean): ReviewView {
  return { mode: 'review', origin: formatOriginForDisplay(origin), rows, settingsLink }
}
