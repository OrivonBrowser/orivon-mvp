// The details page's "Camera and microphone" section: what the person answered
// when the extension's own page asked for a device, and the one command that
// changes an answer or takes it back to "Ask". Pure over the prefs store.
import type { ExtensionPart } from './extensions-detail-parts.js'
import type { ExtensionsDomainDeps } from './extensions-domain.js'
import type { MediaAnswer } from './extension-prefs.js'

export interface MediaRow {
  readonly kind: 'camera' | 'microphone'
  readonly label: 'Camera' | 'Microphone'
  readonly value: MediaAnswer
}

export interface MediaDetails {
  readonly rows: readonly MediaRow[]
}

const DEVICES: ReadonlyArray<Pick<MediaRow, 'kind' | 'label'>> = [
  { kind: 'camera', label: 'Camera' },
  { kind: 'microphone', label: 'Microphone' }
]

/** Nothing until an answer is stored, so the page leaves the section out. */
export const mediaPart: ExtensionPart = (entry, _facts, deps) => {
  const stored = deps.prefs.get(entry.id).media
  const rows = DEVICES.flatMap((device): MediaRow[] => {
    const value = stored[device.kind]
    return value === undefined ? [] : [{ ...device, value }]
  })
  return rows.length === 0 ? {} : { media: { rows } satisfies MediaDetails }
}

/** `{ id, kind, value }` with `value` allow, block or ask; ask drops the answer. Applies to the next request, and stops nothing already running. */
export function setMedia (body: Readonly<Record<string, unknown>>, deps: ExtensionsDomainDeps): { ok: true } | undefined {
  const { id, kind, value } = body
  if (typeof id !== 'string' || (kind !== 'camera' && kind !== 'microphone')) return undefined
  if (value !== 'allow' && value !== 'block' && value !== 'ask') return undefined
  if (!deps.extensions.list().some((entry) => entry.id === id)) return undefined
  const next: { camera?: MediaAnswer, microphone?: MediaAnswer } = { ...deps.prefs.get(id).media }
  if (value === 'ask') delete next[kind]
  else next[kind] = value
  deps.prefs.update(id, { media: next })
  return { ok: true }
}
