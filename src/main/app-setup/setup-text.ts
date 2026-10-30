// What the setup cover and the two sheets of a first visit say. The app's name is the app's own text,
// so it is cut and cleaned here; every other word is fixed.
import { ADDRESS_LIMIT } from '../sad-tab/sad-tab-text.js'
import type { SetupSheet } from '../install/first-visit.js'

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

const VERSION_LIMIT = 40

/** A version as the manifest wrote it, fit to read on one line: no control characters, at most VERSION_LIMIT characters. */
function displayVersion (version: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = version.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return clean.length <= VERSION_LIMIT ? clean : `${clean.slice(0, VERSION_LIMIT - 3)}...`
}

export type CoverState =
  | { readonly kind: 'blocked' | 'download-failed', readonly name: string }
  /** An update the person took is being fetched, and the tab reloads when it is ready. `fromVersion` is absent when the version in use is not readable. */
  | { readonly kind: 'updating', readonly name: string, readonly fromVersion: string | undefined, readonly toVersion: string }

export function coverFor (state: CoverState): CoverText {
  const name = displayName(state.name)
  switch (state.kind) {
    case 'blocked': return { title: `${name} was stopped`, detail: '', busy: false }
    case 'download-failed': return { title: `${name} was not opened`, detail: '', busy: false }
    case 'updating': {
      const to = displayVersion(state.toVersion)
      const from = state.fromVersion === undefined ? '' : displayVersion(state.fromVersion)
      const versions = state.fromVersion === state.toVersion ? `A new build of version ${to}.` : from === '' ? `Version ${to}.` : `Version ${from} to ${to}.`
      return { title: `Updating ${name}`, detail: `${versions} The app reloads when the new version is ready.`, busy: true }
    }
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

/** A failure's reason names the address it asked, which the sheet already shows. */
function withoutAddresses (reason: string): string {
  return reason.replace(/\s*\(https?:[^)]*\)/g, '')
}

export function sheetView (sheet: SetupSheet, address: string, token: string): SetupSheetView {
  const name = displayName(sheet.name)
  const shown = address.slice(0, ADDRESS_LIMIT)
  if (sheet.kind === 'blocked' && sheet.invalid !== undefined) {
    return {
      token,
      kind: 'blocked',
      title: 'Security warning: this app\'s files could not be verified',
      body: `${name} was stopped. Orivon could not verify its files against the address they came from, so someone may be tampering with them. Every permission it held has been removed.`,
      files: [],
      more: '',
      address: shown,
      note: withoutAddresses(sheet.invalid).slice(0, NOTE_LIMIT),
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
      body: sheet.rootMatches || sheet.differingCount > 0
        ? `${name} was stopped. Its files are not the ones its publisher declared. Every permission it held has been removed.`
        : `${name} was stopped. The hash tree its publisher declared contradicts its own files. Every permission it held has been removed.`,
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
    title: `Couldn't check ${name}`,
    body: 'Orivon could not read what the app\'s publisher declares about its files, so it was not opened. Nothing is granted until it is; your answer is kept while you try again.',
    files: [],
    more: '',
    address: shown,
    note: withoutAddresses(sheet.reason).slice(0, NOTE_LIMIT),
    canRetry: true
  }
}
