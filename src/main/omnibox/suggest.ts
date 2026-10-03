// What the address bar offers for the text in it: which rows, in what order, and what to finish the text with.
// Pure: no Electron, no store. The sources (./suggest-sources.ts) turn what the person keeps into scored rows;
// `rank` only merges them.

/** `[start, end)` offsets into the string the range is for. */
export type MatchRange = [start: number, end: number]

export interface SuggestionRow {
  kind: 'verbatim' | 'search' | 'history' | 'bookmark' | 'tab'
  title: string
  /** As shown: no scheme, no `www.`, no trailing slash. */
  address: string
  /** Where choosing the row goes. Main holds it; the page is never told. */
  url?: string
  tabId?: string
  /** A `data:` image, or null for the generic icon. */
  favicon?: string | null
  /** The right-hand text: "Go to address", "Search <engine>", "Switch to this tab". */
  meta?: string
  /** The parts of `title` the text matched. */
  match: MatchRange[]
  /** The parts of `address` the text matched. */
  addressMatch?: MatchRange[]
  /** Set by a source: how good a match the row is. Rows of a kind a source did not score sort last. */
  score?: number
  /** Set by a source: the row is a page the person has shown they want again, so the text may be finished with it. */
  completable?: boolean
}

export const MAX_ROWS = 8
export const MAX_TAB_ROWS = 2

/** The page the row stands for, without what differs between spellings of one address. */
export function stripAddress (url: string): string {
  const withoutScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  const withoutWww = withoutScheme.replace(/^www\./i, '')
  return withoutWww.replace(/\/+$/, '')
}

/** The form two addresses are compared in. */
export const dedupeKey = (url: string): string => stripAddress(url).toLowerCase()

/** What was typed, reduced to what can be found in a stripped address. */
function normalizeTerm (term: string): string {
  return term.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '')
}

/** The words of the text, each without the scheme or `www.` a person may have typed in front. */
export function termsOf (text: string): string[] {
  return text.trim().split(/\s+/).map(normalizeTerm).filter((term) => term !== '').slice(0, 4)
}

const isWordCharacter = (character: string | undefined): boolean => character !== undefined && /[\p{L}\p{N}]/u.test(character)

/** Where `term` starts in `haystack` at its best: 2 at the very start, 1 at a word boundary, 0 when it only appears inside a word, -1 when it is absent. */
function bestPosition (haystack: string, term: string): number {
  const lower = haystack.toLowerCase()
  let best = -1
  for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + 1)) {
    if (at === 0) return 2
    best = Math.max(best, isWordCharacter(lower[at - 1]) ? 0 : 1)
  }
  return best
}

export const TIER_ADDRESS_PREFIX = 300
export const TIER_WORD_PREFIX = 200
export const TIER_SUBSTRING = 100

/** How well `text` matches a page: an address that begins with it beats a word of the title or a part of the
 * address that begins with it, which beats the text appearing inside a word. With several words each one must
 * be found, and the weakest decides. 0 means no match. */
export function matchTier (text: string, title: string, address: string): number {
  const terms = termsOf(text)
  if (terms.length === 0) return 0
  let tier = Number.POSITIVE_INFINITY
  for (const term of terms) {
    const inAddress = bestPosition(address, term)
    const inTitle = bestPosition(title, term)
    let found = 0
    if (terms.length === 1 && inAddress === 2) found = TIER_ADDRESS_PREFIX
    else if (inAddress >= 1 || inTitle >= 1) found = TIER_WORD_PREFIX
    else if (inAddress === 0 || inTitle === 0) found = TIER_SUBSTRING
    if (found === 0) return 0
    tier = Math.min(tier, found)
  }
  return tier
}

/** Every place a word of `text` occurs in `value`, overlapping places joined. */
export function matchRanges (text: string, value: string): MatchRange[] {
  const lower = value.toLowerCase()
  const found: MatchRange[] = []
  for (const term of termsOf(text)) {
    for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + term.length)) found.push([at, at + term.length])
  }
  found.sort((a, b) => a[0] - b[0])
  const joined: MatchRange[] = []
  for (const range of found) {
    const last = joined.at(-1)
    if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else joined.push([range[0], range[1]])
  }
  return joined
}

const DAY_MS = 24 * 60 * 60 * 1000
const VISIT_CAP = 20
const TYPED_CAP = 5
export const BOOKMARK_BONUS = 60
export const TAB_BONUS = 20

/** What a page's history adds to a match: how often it was visited (capped), how often its address was typed
 * in full, and how recently it was visited, which halves in a week. */
export function historyBonus (input: { visitCount: number, typedCount: number, lastVisit: number, now: number }): number {
  const visits = Math.min(Math.max(input.visitCount, 0), VISIT_CAP) * 2
  const typed = Math.min(Math.max(input.typedCount, 0), TYPED_CAP) * 10
  const ageDays = Math.max(0, input.now - input.lastVisit) / DAY_MS
  return visits + typed + Math.round(30 / (1 + ageDays / 7))
}

/** A page is offered to finish the text with once it is a bookmark, was typed in full, or was visited twice. */
export const isCompletablePage = (input: { typedCount: number, visitCount: number }): boolean => input.typedCount >= 1 || input.visitCount >= 2

export interface RankInput {
  /** What is in the address bar. */
  text: string
  /** What Enter does with `text` as it is: a "go to" or a "search" row, or null when nothing can be done with it. */
  verbatim: SuggestionRow | null
  /** Every source's rows, scored. */
  rows: readonly SuggestionRow[]
  /** Finish the text with a page the person keeps; off when the text was not typed or the setting is off. */
  autocomplete: boolean
  /** Where `text` goes, for the row that stands for the finished text. */
  resolve?: (text: string) => string | null
}

export interface Ranked {
  rows: SuggestionRow[]
  /** What to put after `text`, or null. */
  completion: string | null
}

const PRIORITY: Record<SuggestionRow['kind'], number> = { tab: 3, bookmark: 2, history: 1, verbatim: 0, search: 0 }

/** One row per page: a tab beats a bookmark, which beats a history entry, and the best score of the group stays. */
function dedupe (rows: readonly SuggestionRow[]): SuggestionRow[] {
  const byKey = new Map<string, SuggestionRow>()
  for (const row of rows) {
    const key = row.url === undefined ? `${row.kind}:${row.address}` : dedupeKey(row.url)
    const held = byKey.get(key)
    if (held === undefined) { byKey.set(key, row); continue }
    const best = Math.max(row.score ?? 0, held.score ?? 0)
    const winner = PRIORITY[row.kind] > PRIORITY[held.kind] ? row : held
    const completable = row.completable === true || held.completable === true
    byKey.set(key, { ...winner, score: best, completable })
  }
  return [...byKey.values()]
}

const byScore = (a: SuggestionRow, b: SuggestionRow): number => (b.score ?? 0) - (a.score ?? 0)

/** The part of `text` to add, where the page supplying it is known: to the host first, and once the host is
 * typed in full and a slash after it, to the whole address. */
function completionFor (text: string, address: string): string | null {
  // A space anywhere after the first character, a trailing one included, makes the text a phrase, not an address.
  if (/\s/.test(text.trimStart()) || text.trim() === '') return null
  const typed = normalizeTerm(text.trim())
  if (typed === '') return null
  const lowerAddress = address.toLowerCase()
  if (!lowerAddress.startsWith(typed) || address.length <= typed.length) return null
  if (typed.includes('/')) return address.slice(typed.length)
  const hostEnd = address.indexOf('/')
  const host = hostEnd === -1 ? address : address.slice(0, hostEnd)
  return host.length > typed.length ? host.slice(typed.length) : null
}

export function rank (input: RankInput): Ranked {
  const { text, verbatim, autocomplete } = input
  const candidates = dedupe(input.rows).sort(byScore)

  let completion: string | null = null
  let supplier: SuggestionRow | undefined
  if (autocomplete && !text.trimStart().startsWith('?')) {
    for (const row of candidates) {
      if (row.completable !== true) continue
      const suffix = completionFor(text, row.address)
      if (suffix === null) continue
      completion = suffix
      supplier = row
      break
    }
  }

  let first: SuggestionRow | null = verbatim
  if (supplier !== undefined && completion !== null) {
    const finished = text.trim() + completion
    const address = stripAddress(finished)
    // Only the page itself is shown as what it is; a host finished from a deeper page is just an address.
    const exact = supplier.address.toLowerCase() === address.toLowerCase()
    first = {
      kind: exact && supplier.kind !== 'tab' ? supplier.kind : 'history',
      title: exact ? supplier.title : address,
      address,
      url: input.resolve?.(finished) ?? supplier.url ?? '',
      favicon: supplier.favicon ?? null,
      match: [],
      addressMatch: [[0, text.trim().length]]
    }
  }

  const taken = first?.url === undefined ? new Set<string>() : new Set([dedupeKey(first.url)])
  const rest = candidates.filter((row) => row.url === undefined || !taken.has(dedupeKey(row.url)))
  const tabs = rest.filter((row) => row.kind === 'tab').slice(0, MAX_TAB_ROWS)
  const others = rest.filter((row) => row.kind !== 'tab')
  const room = MAX_ROWS - (first === null ? 0 : 1)
  // Tabs come first after row 1, then the rest by score; a tab beyond the second is left out, not moved down.
  const tail = [...tabs, ...others].slice(0, room)
  return { rows: first === null ? tail : [first, ...tail], completion }
}

/** Where the rows a slow source brings go: positions 2 to 5, after the row the person has selected and never
 * before it, so neither row 1 nor the selected row moves. Rows already shown are not added again. */
export function placeLate (rows: readonly SuggestionRow[], late: readonly SuggestionRow[], selected: number): SuggestionRow[] {
  const LAST_LATE_POSITION = 4
  const insertAt = Math.max(1, selected + 1)
  if (insertAt > LAST_LATE_POSITION || rows.length === 0) return [...rows]
  const shown = new Set(rows.flatMap((row) => row.url === undefined ? [] : [dedupeKey(row.url)]))
  const fresh = late.filter((row) => row.url === undefined || !shown.has(dedupeKey(row.url)))
  const take = fresh.slice(0, LAST_LATE_POSITION - insertAt + 1)
  const merged = [...rows.slice(0, insertAt), ...take, ...rows.slice(insertAt)]
  return merged.slice(0, MAX_ROWS)
}
