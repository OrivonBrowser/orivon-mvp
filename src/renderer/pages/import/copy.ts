// What the Import page says, as plain functions of what happened, so the wording is settled in one place.
import type { ImportErrorReason, ImportResult } from '../../../main/import/import-types.js'

export type PageError = ImportErrorReason | 'private' | 'busy'

const count = (value: number): string => value.toLocaleString('en-US')

const noun = (value: number, one: string, many: string): string => `${count(value)} ${value === 1 ? one : many}`

/** The error text for a reason. `browser` names the browser whose files could not be read; absent for a file. */
export function errorText (reason: PageError, browser: string | null): string {
  switch (reason) {
    case 'locked': return `Orivon could not read ${browser ?? 'the other browser'}'s history while it is running. Close ${browser ?? 'it'} and try again.`
    case 'format': return 'This file is not a bookmarks file.'
    case 'private': return 'Importing is not available in a private window.'
    case 'busy': return 'Another import is running. Wait for it to finish, then try again.'
    case 'unreadable': return browser === null ? 'This file could not be read.' : 'This profile could not be read.'
  }
}

/** The first line of a finished import. `from` is the browser's name, or null for a file. */
export function headline (result: ImportResult, from: string | null): string {
  const source = from ?? 'the file'
  const parts: string[] = []
  if (result.bookmarks > 0) parts.push(noun(result.bookmarks, 'bookmark', 'bookmarks'))
  if (result.pages > 0) parts.push(`${count(result.pages)} ${result.pages === 1 ? 'page' : 'pages'} of history`)
  if (parts.length > 0) return `Imported ${parts.join(' and ')} from ${source}.`
  return result.known > 0 ? `Everything in ${source} was already in Orivon.` : `Nothing new was found in ${source}.`
}

/** The lines under the headline: where the bookmarks are, what was left out, what was already there. */
export function details (result: ImportResult): string[] {
  const lines: string[] = []
  if (result.bookmarks > 0) {
    lines.push(result.target === 'folder' && result.folderTitle !== undefined
      ? `Bookmarks are in the folder "${result.folderTitle}" on your bookmarks bar.`
      : 'Your bookmarks bar now shows them.')
  }
  if (result.known > 0) lines.push(`${noun(result.known, 'bookmark was', 'bookmarks were')} already in Orivon.`)
  if (result.skipped > 0) {
    lines.push(result.skipped === 1
      ? '1 bookmark was skipped because its address cannot be opened in Orivon.'
      : `${count(result.skipped)} bookmarks were skipped because their addresses cannot be opened in Orivon.`)
  }
  return lines
}

export function progressText (phase: 'bookmarks' | 'history' | null): string {
  return phase === 'history' ? 'Importing history…' : 'Importing bookmarks…'
}
