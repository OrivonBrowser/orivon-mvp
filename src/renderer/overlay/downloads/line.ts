// What a row of the downloads bubble says and offers in each state. Pure, so the table is tested without a document.
import type { DownloadEntry, DownloadReason } from '../../../main/downloads/download-types.js'
import { formatBytes, sourceLabel, statusLine } from '../../pages/shared/format-bytes.js'

export type BubbleActionId = 'pause' | 'resume' | 'cancel' | 'retry' | 'remove' | 'showInFolder' | 'keep' | 'discard'

export interface BubbleAction {
  readonly id: BubbleActionId
  readonly label: string
  /** A labelled button rather than an icon: the answer to a held file. */
  readonly text?: boolean
  /** Shown only when the row is pointed at or focused; the others are always there. */
  readonly reveal?: boolean
}

const PAUSE: BubbleAction = { id: 'pause', label: 'Pause' }
const RESUME: BubbleAction = { id: 'resume', label: 'Resume' }
const CANCEL: BubbleAction = { id: 'cancel', label: 'Cancel' }
const RETRY: BubbleAction = { id: 'retry', label: 'Retry', reveal: true }
const SHOW: BubbleAction = { id: 'showInFolder', label: 'Show in folder', reveal: true }
const DISCARD: BubbleAction = { id: 'discard', label: 'Discard', text: true }
const KEEP: BubbleAction = { id: 'keep', label: 'Keep', text: true }

export function rowActions (entry: DownloadEntry): readonly BubbleAction[] {
  switch (entry.state) {
    case 'progressing': return [PAUSE, CANCEL]
    case 'paused': return [RESUME, CANCEL]
    case 'held': return [DISCARD, KEEP]
    case 'completed': return entry.missing === true ? [RETRY] : [SHOW]
    case 'cancelled':
    case 'interrupted': return [RETRY]
  }
}

/** What Enter, or a click on the row, does. A type that runs code is shown in its folder, never opened. */
export function primaryAction (entry: DownloadEntry): 'open' | 'showInFolder' | BubbleActionId | null {
  switch (entry.state) {
    case 'completed': return entry.missing === true ? null : entry.danger ? 'showInFolder' : 'open'
    case 'paused': return 'resume'
    case 'cancelled':
    case 'interrupted': return 'retry'
    case 'progressing':
    case 'held': return null
  }
}

/** Only a finished row leaves the list on Delete; a running one or one waiting for an answer stays. */
export function isRemovable (entry: DownloadEntry): boolean {
  return entry.state === 'completed' || entry.state === 'cancelled' || entry.state === 'interrupted'
}

const SHORT_REASONS: Readonly<Record<DownloadReason, string>> = {
  network: 'network error',
  server: 'the server stopped',
  disk: 'disk full or no permission',
  closed: 'Orivon closed first',
  flood: 'too many from this site'
}

export function lineFor (entry: DownloadEntry): string {
  switch (entry.state) {
    case 'completed': return entry.missing === true ? 'Moved or deleted' : [formatBytes(entry.total > 0 ? entry.total : entry.received), sourceLabel(entry.url)].join(' · ')
    case 'interrupted': return `Failed: ${SHORT_REASONS[entry.reason ?? 'network']}`
    default: return statusLine(entry)
  }
}

/** A finished file of a type that runs code: Orivon shows where it is and never opens it. */
export function showsFolderBadge (entry: DownloadEntry): boolean {
  return entry.state === 'completed' && entry.danger && entry.missing !== true
}
