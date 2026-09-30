// What a person can do to a download in each state. Pure, so the table is tested without a document.
import type { DownloadEntry } from '../../../main/downloads/download-types.js'

export type ActionId = 'pause' | 'resume' | 'cancel' | 'retry' | 'remove' | 'showInFolder' | 'deleteFile'

export interface RowAction {
  readonly id: ActionId
  readonly label: string
  /** Asks for a second click: it cannot be taken back. */
  readonly confirm?: { readonly label: string }
}

const PAUSE: RowAction = { id: 'pause', label: 'Pause' }
const RESUME: RowAction = { id: 'resume', label: 'Resume' }
const CANCEL: RowAction = { id: 'cancel', label: 'Cancel' }
const RETRY: RowAction = { id: 'retry', label: 'Retry' }
const REMOVE: RowAction = { id: 'remove', label: 'Remove from list' }
const SHOW: RowAction = { id: 'showInFolder', label: 'Show in folder' }
const DELETE: RowAction = { id: 'deleteFile', label: 'Delete file', confirm: { label: 'Click again to delete the file' } }

export function actionsFor (entry: DownloadEntry): readonly RowAction[] {
  switch (entry.state) {
    case 'progressing': return [PAUSE, CANCEL]
    case 'paused': return [RESUME, CANCEL]
    case 'completed': return entry.missing === true ? [RETRY, REMOVE] : [SHOW, DELETE, REMOVE]
    case 'cancelled':
    case 'interrupted': return [RETRY, REMOVE]
  }
}

/** Whether the file's name opens it: finished, still there, and not a type that runs code. */
export function opensFile (entry: DownloadEntry): boolean {
  return entry.state === 'completed' && entry.missing !== true && !entry.danger
}

/** Delete and Backspace take a row off the list only when nothing is running in it. */
export function isRemovable (entry: DownloadEntry): boolean {
  return entry.state !== 'progressing' && entry.state !== 'paused'
}

/** Space pauses a running download and resumes a paused one; it does nothing to any other. */
export function spaceAction (entry: DownloadEntry): ActionId | null {
  if (entry.state === 'progressing') return 'pause'
  return entry.state === 'paused' ? 'resume' : null
}
