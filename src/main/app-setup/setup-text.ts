// What the setup cover and the two sheets of a first visit say. The app's name is the app's own text,
// so it is cut and cleaned here; every other word is fixed.
import { ADDRESS_LIMIT } from '../sad-tab/sad-tab-text.js'
import type { SetupSheet, SetupStage } from '../install/first-visit.js'

const NAME_LIMIT = 80
const NOTE_LIMIT = 160
export const MAX_LISTED_FILES = 8

/** The app's name as it may be shown: no control characters, at most NAME_LIMIT characters. */
export function displayName (name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (clean === '') return 'this app'
  return clean.length <= NAME_LIMIT ? clean : `${clean.slice(0, NAME_LIMIT - 3)}...`
}

export interface CoverText {
  readonly title: string
  readonly detail: string
  /** Something is still moving: the cover draws its slim bar. */
  readonly busy: boolean
}

export type CoverState = SetupStage | { readonly kind: 'blocked' | 'download-failed', readonly name: string }

export function coverFor (state: CoverState): CoverText {
  const name = displayName(state.name)
  switch (state.kind) {
    case 'asking': return { title: `Opening ${name}`, detail: 'Orivon is asking what this app may do before it downloads anything.', busy: true }
    case 'verifying': return { title: `Setting up ${name}`, detail: 'Orivon downloads the app\'s files and checks them before it opens.', busy: true }
    case 'blocked':
    case 'download-failed': return { title: `${name} was not opened`, detail: '', busy: false }
  }
}

export interface SetupSheetView {
  /** Names the pending question: the page sends it back with its answer, so a late click on a sheet that is gone answers nothing. */
  readonly token: string
  readonly kind: SetupSheet['kind']
  readonly title: string
  readonly body: string
  readonly files: readonly string[]
  /** "and 4 more", or empty. */
  readonly more: string
  readonly address: string
  /** One short line of detail under the body. */
  readonly note: string
  readonly canRetry: boolean
}

const FILE_LIMIT = 120

export function sheetView (sheet: SetupSheet, address: string, token: string): SetupSheetView {
  const name = displayName(sheet.name)
  const shown = address.slice(0, ADDRESS_LIMIT)
  if (sheet.kind === 'blocked' && sheet.invalid !== undefined) {
    return {
      token,
      kind: 'blocked',
      title: 'Security warning: this app\'s files could not be accepted',
      body: `${name} was not opened. Its files are incomplete or not acceptable, and every permission you gave it has been removed.`,
      files: [],
      more: '',
      address: shown,
      note: sheet.invalid.slice(0, NOTE_LIMIT),
      canRetry: false
    }
  }
  if (sheet.kind === 'blocked') {
    const listed = sheet.differing.slice(0, MAX_LISTED_FILES).map((path) => path.slice(0, FILE_LIMIT))
    const left = sheet.differingCount - listed.length
    return {
      token,
      kind: 'blocked',
      title: 'Security warning: this app\'s files do not match',
      body: sheet.rootMatches
        ? `${name} was not opened. Its files are not the ones its publisher declared, and every permission you gave it has been removed.`
        : `${name} was not opened. The hash tree its publisher declared contradicts its own files, and every permission you gave it has been removed.`,
      files: listed,
      more: left > 0 ? `and ${String(left)} more` : '',
      address: shown,
      note: 'Visiting it again asks you again.',
      canRetry: false
    }
  }
  return {
    token,
    kind: 'download-failed',
    title: `Couldn't download ${name}`,
    body: 'Orivon could not download all of the app\'s files, so nothing was opened. The permissions you gave are kept.',
    files: [],
    more: '',
    address: shown,
    note: sheet.reason.slice(0, NOTE_LIMIT),
    canRetry: true
  }
}
