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
  /** The button that grants: "Grant WebGPU" when WebGPU is all that is asked, "Allow" otherwise. */
  readonly allowLabel: string
  /** Set when granting also turns the graphics mode on and Orivon must start again for it: what that costs. */
  readonly restartNote: string | null
  /** How long the buttons are drawn as not ready: main refuses an answer that soon after the show. */
  readonly guardMs: number
}

/** The offer that follows a grant that turned the graphics mode on: what happens after Orivon starts again, and the way to start it. */
export interface RestartView {
  readonly mode: 'restart'
  /** Which offer this is: the restart command names it, and main accepts it only for the one on screen. */
  readonly id: string
  readonly line: string
  readonly note: string
  /** As for the question: main refuses a restart that soon after the show. */
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
export const RESTART_NOTE = 'Orivon restarts to turn WebGPU on. It may use more battery, and on some laptops videos can go blank.'
export const RESTART_LINE = 'WebGPU starts after Orivon restarts.'
export const RESTART_OFFER_NOTE = 'Orivon opens this site again. Your other tabs and windows are not restored.'
export const RESTART_RESTORED_NOTE = 'Your tabs and windows open again.'
export const RESTART_BLANK_NOTE = 'Your tabs and windows are not restored.'

/** What the start that follows a restart offer brings back: the saved tabs and windows, the site of this page alone, or none of them. */
export type RestartReopens = 'session' | 'page' | 'none'

const RESTART_NOTES: Readonly<Record<RestartReopens, string>> = { session: RESTART_RESTORED_NOTE, page: RESTART_OFFER_NOTE, none: RESTART_BLANK_NOTE }

const WANTS: Readonly<Partial<Record<SiteKind, string>>> = {
  camera: 'wants to use your camera',
  microphone: 'wants to use your microphone',
  clipboardRead: 'wants to see text and images you copied',
  location: 'wants to know your location',
  midi: 'wants to use your MIDI devices',
  idle: 'wants to know when you are away from this computer',
  windowManagement: 'wants to place windows across your screens',
  notifications: 'wants to show notifications',
  webgpu: 'wants to use your graphics card for WebGPU',
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

export function askView (id: string, origin: string, kinds: readonly SiteKind[], sysex: boolean, restart: boolean, isPrivate: boolean, guardMs: number): AskView {
  const onlyWebGpu = kinds.length === 1 && kinds[0] === 'webgpu'
  return {
    mode: 'ask',
    id,
    origin: formatOriginForDisplay(origin),
    lines: askLines(kinds, sysex),
    locationNote: kinds.includes('location') ? LOCATION_NOTE : null,
    privateNote: isPrivate ? PRIVATE_NOTE : null,
    allowLabel: onlyWebGpu ? 'Grant WebGPU' : 'Allow',
    restartNote: restart && onlyWebGpu ? RESTART_NOTE : null,
    guardMs
  }
}

export function restartView (id: string, reopens: RestartReopens, guardMs: number): RestartView {
  return { mode: 'restart', id, line: RESTART_LINE, note: RESTART_NOTES[reopens], guardMs }
}

export function reviewView (origin: string, rows: readonly ReviewRow[], settingsLink: boolean): ReviewView {
  return { mode: 'review', origin: formatOriginForDisplay(origin), rows, settingsLink }
}
