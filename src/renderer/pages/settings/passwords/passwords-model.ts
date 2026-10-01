// What the Passwords list decides, apart from the page it is drawn on: the order, the search and the marks it
// leaves, how many rows show, and the words a finished import or export is told in.

export type VaultState = 'ready' | 'unavailable' | 'private'

/** A saved login as main lists it: never with its password. */
export interface LoginRow {
  readonly id: string
  readonly origin: string
  readonly username: string
  readonly created: number
  readonly used: number
}

/** A stretch of a string to draw in bold: `start` is the first character, `end` the one after the last. */
export interface Mark {
  readonly start: number
  readonly end: number
}

export interface ListEntry {
  readonly login: LoginRow
  readonly host: string
  readonly hostMarks: readonly Mark[]
  readonly userMarks: readonly Mark[]
}

/** More than this many rows start hidden behind "Show all". */
export const SHOWN_LIMIT = 200

/** What main answers to an import or an export. */
export type TransferOutcome =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed', readonly reason: string }
  | { readonly kind: 'imported', readonly added: number, readonly updated: number, readonly unchanged: number, readonly skipped: number }
  | { readonly kind: 'exported', readonly count: number }

export interface Notice {
  readonly tone: 'ok' | 'warn' | 'error'
  readonly text: string
}

/** The site as a person reads it: `https://` is the expected case and is left off; a plain `http://` site is shown as such. */
export function hostOf (origin: string): string {
  return origin.startsWith('https://') ? origin.slice('https://'.length) : origin
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/** By site, then username. */
export function sortLogins (logins: readonly LoginRow[]): LoginRow[] {
  return [...logins].sort((a, b) => collator.compare(hostOf(a.origin), hostOf(b.origin)) || collator.compare(a.username, b.username))
}

/** Where `words` occur in `text`, ignoring case, as marks that do not overlap. */
export function marksFor (text: string, words: readonly string[]): Mark[] {
  const lower = text.toLowerCase()
  const found: Mark[] = []
  for (const word of words) {
    for (let from = lower.indexOf(word); from >= 0; from = lower.indexOf(word, from + word.length)) found.push({ start: from, end: from + word.length })
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: Mark[] = []
  for (const mark of found) {
    const last = merged.at(-1)
    if (last !== undefined && mark.start <= last.end) merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, mark.end) }
    else merged.push(mark)
  }
  return merged
}

/** The logins every word of `query` appears in, by site or by username, in the order given, with where the words fall. */
export function filterLogins (logins: readonly LoginRow[], query: string): ListEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== '')
  const entries: ListEntry[] = []
  for (const login of logins) {
    const host = hostOf(login.origin)
    const hostMarks = marksFor(host, words)
    const userMarks = marksFor(login.username, words)
    const everyWordFound = words.every((word) => host.toLowerCase().includes(word) || login.username.toLowerCase().includes(word))
    if (everyWordFound) entries.push({ login, host, hostMarks, userMarks })
  }
  return entries
}

/** The first rows, unless all were asked for. */
export function visibleEntries<T> (entries: readonly T[], showAll: boolean): { readonly shown: readonly T[], readonly hidden: number } {
  if (showAll || entries.length <= SHOWN_LIMIT) return { shown: entries, hidden: 0 }
  return { shown: entries.slice(0, SHOWN_LIMIT), hidden: entries.length - SHOWN_LIMIT }
}

const plural = (count: number, one: string, many: string): string => `${String(count)} ${count === 1 ? one : many}`

const FAILURES: Readonly<Record<string, string>> = {
  unavailable: 'Passwords cannot be saved on this computer, so there is nothing to move.',
  'too-large': 'That file is too large to be a list of passwords.',
  unreadable: 'That file could not be read.',
  'not-passwords': 'That file does not look like a list of passwords. It needs a header naming the address, username and password columns.',
  'not-written': 'The file could not be written there. Pick another place.'
}

/** What to tell the person after an import or an export; nothing when they cancelled. */
export function transferNotice (outcome: TransferOutcome): Notice | null {
  switch (outcome.kind) {
    case 'cancelled':
      return null
    case 'failed':
      return { tone: 'error', text: FAILURES[outcome.reason] ?? 'That did not work.' }
    case 'imported': {
      const imported = outcome.added + outcome.updated
      const parts = [`Imported ${plural(imported, 'password', 'passwords')}${outcome.updated > 0 ? `, ${String(outcome.updated)} of them updated` : ''}.`]
      if (outcome.unchanged > 0) parts.push(`${plural(outcome.unchanged, 'was', 'were')} already saved.`)
      if (outcome.skipped > 0) parts.push(`${plural(outcome.skipped, 'row was', 'rows were')} skipped.`)
      return { tone: 'ok', text: parts.join(' ') }
    }
    case 'exported':
      return { tone: 'warn', text: `Exported ${plural(outcome.count, 'password', 'passwords')} to a file anyone can read. Delete it when you are done.` }
  }
}

export const BANNER_TEXT: Readonly<Record<'unavailable' | 'private', string>> = {
  unavailable: 'Orivon cannot reach a system keyring, so it does not save passwords. Install or unlock GNOME Keyring or KWallet, then restart Orivon.',
  private: 'Passwords are not saved or filled in a private window.'
}

const MARK_COLORS = ['blue', 'green', 'orange', 'red', 'purple', 'pink', 'teal', 'gray'] as const

/** The letter a site's mark shows: the first of its name, without a leading `www.`. */
export function markLetter (host: string): string {
  return (host.replace(/^https?:\/\//, '').replace(/^www\./, '').charAt(0) || '?').toUpperCase()
}

/** One of the named mark colours, the same for a site every time. */
export function markColor (host: string): string {
  let hash = 0
  for (const char of host.replace(/^www\./, '')) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return MARK_COLORS[hash % MARK_COLORS.length] ?? 'blue'
}
