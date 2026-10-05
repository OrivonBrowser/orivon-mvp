// What the picker's page is told, and the commands it may send back. Pure: no `electron` import. The page gets text,
// ids and data URLs; every command is checked here against the exact keys it may carry.
import type { PickerAudio, PickerCard, PickerSegment, SegmentMode } from './picker-model.js'

export interface PickerView {
  /** Which question this is: every command names it, and main accepts it only for the one on screen. */
  readonly id: string
  readonly title: string
  readonly segments: readonly PickerSegment[]
  readonly segment: PickerSegment
  readonly cards: Readonly<Record<PickerSegment, readonly PickerCard[]>>
  /** How the window and screen segments are filled; a tab segment is always a list. */
  readonly modes: { readonly window: SegmentMode, readonly screen: SegmentMode }
  /** The line a segment shows when the system has not let Orivon record the screen. */
  readonly permissionText: string
  readonly audio: PickerAudio
  /** The card selected when the picker opens. */
  readonly selected: string | null
  /** How long Share is drawn as not ready: main refuses a share that soon after the picker is drawn. */
  readonly guardMs: number
}

/** Pushed while the picker is open. */
export type PickerEvent =
  | { readonly type: 'cards', readonly segment: PickerSegment, readonly cards: readonly PickerCard[] }
  | { readonly type: 'arm' }

export type PickerCommand =
  | { readonly type: 'drawn' | 'cancel' | 'open-settings', readonly id: string }
  | { readonly type: 'segment', readonly id: string, readonly segment: PickerSegment }
  | { readonly type: 'share', readonly id: string, readonly card: string, readonly audio: boolean }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isSegment = (value: unknown): value is PickerSegment => value === 'tab' || value === 'window' || value === 'screen'

/** Only the fixed shapes, with no extra keys: anything else is not a command of this overlay. */
export function asPickerCommand (command: unknown): PickerCommand | undefined {
  if (!isRecord(command)) return undefined
  const { type, ...rest } = command
  const keys = Object.keys(rest).sort().join(',')
  const { id } = rest
  if (typeof id !== 'string') return undefined
  if ((type === 'drawn' || type === 'cancel' || type === 'open-settings') && keys === 'id') return { type, id }
  if (type === 'segment' && keys === 'id,segment') return isSegment(rest['segment']) ? { type, id, segment: rest['segment'] } : undefined
  if (type === 'share' && keys === 'audio,card,id') {
    return typeof rest['card'] === 'string' && typeof rest['audio'] === 'boolean' ? { type, id, card: rest['card'], audio: rest['audio'] } : undefined
  }
  return undefined
}

/** The payload of a show: the id of a question main is holding. */
export function asPickerId (payload: unknown): string | undefined {
  return isRecord(payload) && Object.keys(payload).length === 1 && typeof payload['id'] === 'string' ? payload['id'] : undefined
}
