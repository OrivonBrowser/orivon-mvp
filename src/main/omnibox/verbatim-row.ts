// The first row of the dropdown: what Enter does with the text as it stands. It asks the same classifier the
// address bar's submit asks, so the row never promises something else than Enter delivers.
import type { OmniboxResult } from '../browsing/omnibox.js'
import type { SuggestionRow } from './suggest.js'

export const GO_TO_ADDRESS = 'Go to address'

export interface VerbatimDeps {
  /** `parseOmniboxInput` with the window's search engine and development names. */
  classify: (text: string) => OmniboxResult
  /** One of the shell's own pages: `navigateTab` opens it before it classifies anything. */
  isInternal: (text: string) => boolean
  /** The engine's name for "Search <engine>"; empty for the person's own address. */
  engineName: string
  /** The engine a keyword in `query` names and what it will be asked, or null when `query` has no keyword. */
  keyword?: (query: string) => { name: string, terms: string } | null
}

/** The text a forced search (`? cats`) looks for. */
export function forcedQuery (text: string): string | null {
  const trimmed = text.trim()
  return trimmed.startsWith('?') ? trimmed.slice(1).trim() : null
}

export function verbatimRow (text: string, deps: VerbatimDeps): SuggestionRow | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (deps.isInternal(trimmed)) {
    return { kind: 'verbatim', title: trimmed, address: '', url: trimmed, favicon: null, meta: GO_TO_ADDRESS, match: [] }
  }
  const result = deps.classify(trimmed)
  if (result.kind === 'reject') return null
  if (result.kind === 'url') {
    return { kind: 'verbatim', title: trimmed, address: '', url: result.url, favicon: null, meta: GO_TO_ADDRESS, match: [] }
  }
  const query = forcedQuery(trimmed) ?? trimmed
  const byKeyword = deps.keyword?.(query) ?? null
  if (byKeyword !== null) {
    return { kind: 'search', title: byKeyword.terms, address: '', url: result.url, favicon: null, meta: `Search ${byKeyword.name}`, match: [] }
  }
  return {
    kind: 'search', title: query, address: '', url: result.url, favicon: null,
    meta: deps.engineName === '' ? 'Search the web' : `Search ${deps.engineName}`, match: []
  }
}
