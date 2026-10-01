// What Electron calls each thing a site can ask for, and which kind of the
// site-settings table it is. Pure: the request handler's `details` and the
// check handler's `details` are read as plain objects, so the mapping is
// unit-tested without a session.
import type { SiteKind } from './kinds.js'

/** A request the asker owns: the kinds it is about and whether the stronger MIDI wording applies. */
export interface SiteRequest {
  readonly kinds: readonly SiteKind[]
  /** The request is for MIDI with system-exclusive messages, which can reprogram a device. */
  readonly sysex: boolean
}

/** A Map, not an object: a page-chosen name such as `toString` must not find anything on a prototype. */
const PLAIN: ReadonlyMap<string, SiteKind> = new Map<string, SiteKind>([
  ['clipboard-read', 'clipboardRead'],
  ['deprecated-sync-clipboard-read', 'clipboardRead'],
  ['geolocation', 'location'],
  ['midi', 'midi'],
  ['midiSysex', 'midi'],
  ['idle-detection', 'idle'],
  ['window-management', 'windowManagement']
])

/** Every Electron permission name a per-site asker answers: the gate's test pins its own restated list to this. */
export const SITE_ASKED_PERMISSIONS: readonly string[] = ['media', ...PLAIN.keys()]

function mediaKinds (details: unknown): SiteKind[] | undefined {
  const types = (details as { mediaTypes?: unknown } | null)?.mediaTypes
  if (!Array.isArray(types)) return undefined
  const kinds: SiteKind[] = []
  for (const type of types) {
    // Anything but the two device kinds makes the request not ours (a tab capture asks with none).
    if (type === 'video') { if (!kinds.includes('camera')) kinds.push('camera') } else if (type === 'audio') { if (!kinds.includes('microphone')) kinds.push('microphone') } else return undefined
  }
  return kinds.length === 0 ? undefined : kinds
}

/**
 * The kinds a permission request is about, or undefined when the asker does not own it. A `media` request with no
 * device type is a tab capture, which the gate's own rule decides. One stored allow covers plain and system-exclusive
 * MIDI, so every MIDI request carries the stronger wording whichever name Chromium sends it under.
 */
export function requestOf (permission: string, details: unknown): SiteRequest | undefined {
  if (permission === 'media') {
    const kinds = mediaKinds(details)
    return kinds === undefined ? undefined : { kinds, sysex: false }
  }
  const kind = PLAIN.get(permission)
  return kind === undefined ? undefined : { kinds: [kind], sysex: kind === 'midi' }
}

/**
 * The kind a permission check is about, or undefined when the asker does not own it. A `media` check names one device
 * type; an unknown one is refused by the caller rather than mapped.
 */
export function checkOf (permission: string, details: unknown): SiteKind | 'unknown' | undefined {
  if (permission === 'media') {
    const type = (details as { mediaType?: unknown } | null)?.mediaType
    if (type === 'video') return 'camera'
    if (type === 'audio') return 'microphone'
    return 'unknown'
  }
  return PLAIN.get(permission)
}
