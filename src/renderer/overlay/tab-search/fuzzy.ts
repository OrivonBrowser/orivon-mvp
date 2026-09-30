// Matching for tab search: case- and accent-insensitive, ranked word start over substring over the address
// over letters in order, and the ranges to highlight. Pure: the only copy of the rules.

export type Range = readonly [start: number, end: number]
export type MatchKind = 'word' | 'substring' | 'subsequence'

export interface Match {
  readonly score: number
  /** Positions in the text as given, merged and ascending. */
  readonly ranges: readonly Range[]
  readonly kind: MatchKind
}

/** Fewer letters than this in order are noise: one letter would match nearly everything. */
const MIN_SUBSEQUENCE = 3
const WORD_BASE = 4000
const SUBSTRING_BASE = 3000
const ADDRESS_BASE = 2000
const SUBSEQUENCE_BASE = 1000
const POSITION_CAP = 999

interface Folded {
  readonly text: string
  /** For each folded character, where its source starts and ends in the original text. */
  readonly starts: readonly number[]
  readonly ends: readonly number[]
}

function foldWithMap (text: string): Folded {
  let folded = ''
  const starts: number[] = []
  const ends: number[] = []
  let position = 0
  for (const character of text) {
    const out = character.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    for (let unit = 0; unit < out.length; unit += 1) {
      starts.push(position)
      ends.push(position + character.length)
    }
    folded += out
    position += character.length
  }
  return { text: folded, starts, ends }
}

/** Lower case with the accents taken off, so "Café" and "cafe" are the same word. */
export function fold (text: string): string {
  return foldWithMap(text).text
}

function merge (ranges: Range[]): Range[] {
  const merged: Array<[number, number]> = []
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1)
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

const isWordCharacter = (character: string | undefined): boolean => character !== undefined && /[\p{L}\p{N}]/u.test(character)

/** The folded range `[from, to)` as a range of the original text. */
function original (haystack: Folded, from: number, to: number): Range {
  return [haystack.starts[from] ?? 0, haystack.ends[to - 1] ?? 0]
}

function substringMatch (haystack: Folded, needle: string): { index: number, word: boolean } | null {
  let first = -1
  for (let at = haystack.text.indexOf(needle); at !== -1; at = haystack.text.indexOf(needle, at + 1)) {
    if (!isWordCharacter(haystack.text[at - 1])) return { index: at, word: true }
    if (first === -1) first = at
  }
  return first === -1 ? null : { index: first, word: false }
}

function subsequenceMatch (haystack: Folded, needle: string): Range[] | null {
  const hits: number[] = []
  let from = 0
  for (const letter of needle) {
    const at = haystack.text.indexOf(letter, from)
    if (at === -1) return null
    hits.push(at)
    from = at + letter.length
  }
  return merge(hits.map((at) => original(haystack, at, at + 1)))
}

function matchFolded (haystack: Folded, needle: string): Match | null {
  if (needle === '') return { score: 0, ranges: [], kind: 'substring' }
  const found = substringMatch(haystack, needle)
  if (found !== null) {
    const index = Math.min(found.index, POSITION_CAP)
    return { score: (found.word ? WORD_BASE : SUBSTRING_BASE) - index, ranges: [original(haystack, found.index, found.index + needle.length)], kind: found.word ? 'word' : 'substring' }
  }
  if ([...needle].length < MIN_SUBSEQUENCE) return null
  const ranges = subsequenceMatch(haystack, needle)
  if (ranges === null) return null
  const span = (ranges.at(-1)?.[1] ?? 0) - (ranges[0]?.[0] ?? 0)
  return { score: SUBSEQUENCE_BASE - Math.min(span, POSITION_CAP), ranges, kind: 'subsequence' }
}

/** How well `query` (one word) matches `text`, or null. The empty query matches everything with no ranges. */
export function score (query: string, text: string): Match | null {
  return matchFolded(foldWithMap(text), fold(query))
}

export interface RowMatch {
  /** True when a word matched only as letters in order, which is the weakest kind of hit. */
  readonly loose: boolean
  readonly score: number
  readonly titleRanges: readonly Range[]
  readonly hostRanges: readonly Range[]
}

/**
 * A query of several words matches a row when every word matches its title or its address. A word found in the
 * address ranks under the same word found in the title, and above letters merely in order.
 */
export function matchRow (query: string, title: string, host: string): RowMatch | null {
  const words = query.split(/\s+/).filter((word) => word !== '')
  if (words.length === 0) return { score: 0, loose: false, titleRanges: [], hostRanges: [] }
  const titleFolded = foldWithMap(title)
  const hostFolded = foldWithMap(host)
  let total = 0
  let loose = false
  const titleRanges: Range[] = []
  const hostRanges: Range[] = []
  for (const word of words) {
    const needle = fold(word)
    const inTitle = matchFolded(titleFolded, needle)
    const inHost = matchFolded(hostFolded, needle)
    const address = inHost !== null && inHost.kind !== 'subsequence' ? { score: ADDRESS_BASE - Math.min(inHost.ranges[0]?.[0] ?? 0, POSITION_CAP), ranges: inHost.ranges } : null
    if (inTitle === null && address === null) return null
    if (address === null && inTitle?.kind === 'subsequence') loose = true
    total += Math.max(inTitle?.score ?? 0, address?.score ?? 0)
    if (inTitle !== null) titleRanges.push(...inTitle.ranges)
    if (address !== null) hostRanges.push(...address.ranges)
  }
  return { score: total, loose, titleRanges: merge(titleRanges), hostRanges: merge(hostRanges) }
}

/** The text cut at `ranges`, for drawing the hits: each piece says whether it is one. */
export function segments (text: string, ranges: readonly Range[]): Array<{ text: string, hit: boolean }> {
  const pieces: Array<{ text: string, hit: boolean }> = []
  let at = 0
  for (const [start, end] of ranges) {
    if (start > at) pieces.push({ text: text.slice(at, start), hit: false })
    pieces.push({ text: text.slice(start, end), hit: true })
    at = end
  }
  if (at < text.length) pieces.push({ text: text.slice(at), hit: false })
  return pieces
}
