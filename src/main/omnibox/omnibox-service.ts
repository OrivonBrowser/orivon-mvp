// One window's address-bar suggestions: the rows the last text produced, which one is selected, and what a
// choice of a row means. It holds every address itself and hands the page rows without them, so what the page
// or the chrome sends back is an index, never an address. No Electron: the window's effects are
// ./omnibox-actions.ts, and everything this needs from outside arrives in `OmniboxDeps`.
import { placeLate } from './suggest.js'
import type { MatchRange, SuggestionRow } from './suggest.js'
import { rank } from './suggest.js'
import { LATE_SOURCES, SUGGEST_SOURCES } from './suggest-sources.js'
import type { LateSource, SuggestContext, SuggestSource } from './suggest-sources.js'

export type Disposition = 'current' | 'tab' | 'background'

/** What the overlay page is shown of a row. */
export interface PageRow {
  kind: SuggestionRow['kind']
  title: string
  address: string
  favicon: string | null
  meta: string
  match: MatchRange[]
  addressMatch: MatchRange[]
}

/** What the page is told: the rows and which one Enter would choose. */
export interface Snapshot { seq: number, rows: PageRow[], selected: number }

/** What a choice asks the window to do. `target` is the text a tab's own navigation takes for `current`, and
 * an address for a new tab. `markTyped` is a page that exists, to count as typed. */
export type Outcome =
  | { type: 'go', disposition: Disposition, target: string, markTyped: string | null }
  | { type: 'switch', tabId: string }

export interface QueryReply {
  seq: number
  count: number
  /** What to put after the text, or null. */
  completion: string | null
}

export interface OmniboxDeps {
  context: () => SuggestContext
  /** What Enter does with the text as it is, or null when it cannot be done (empty, or a scheme that is refused). */
  verbatim: (text: string) => SuggestionRow | null
  autocomplete: () => boolean
  /** Where `text` goes as an address, or null. */
  resolve: (text: string) => string | null
  /** The icon of each host that has one, as history keeps them. */
  faviconsFor: (hosts: readonly string[]) => Record<string, string>
  /** Called with the rows as they are after a slow source has added to them. */
  onLate: (snapshot: Snapshot) => void
  sources?: readonly SuggestSource[]
  lateSources?: readonly LateSource[]
}

export const hostKey = (url: string): string => {
  try { return new URL(url).hostname } catch { return '' }
}

export function pageRow (row: SuggestionRow): PageRow {
  return {
    kind: row.kind, title: row.title, address: row.address, favicon: row.favicon ?? null, meta: row.meta ?? '',
    match: row.match, addressMatch: row.addressMatch ?? []
  }
}

export class OmniboxService {
  private seq = 0
  private text = ''
  private completion: string | null = null
  private rows: SuggestionRow[] = []
  private selected = 0
  private late: AbortController | null = null

  constructor (private readonly deps: OmniboxDeps) {}

  /** `typing` is whether the text was just typed by hand, the only time it may be finished for the person. */
  query (text: string, typing: boolean): QueryReply {
    this.late?.abort()
    this.late = null
    this.seq += 1
    this.text = text
    this.selected = 0
    this.completion = null
    if (text.trim() === '') {
      this.rows = []
      return { seq: this.seq, count: 0, completion: null }
    }
    const ctx = { ...this.deps.context() }
    const fromSources = (this.deps.sources ?? SUGGEST_SOURCES).flatMap((source) => source(text, ctx))
    const ranked = rank({
      text,
      verbatim: this.deps.verbatim(text),
      rows: fromSources,
      autocomplete: typing && this.deps.autocomplete(),
      resolve: this.deps.resolve
    })
    this.rows = this.withFavicons(ranked.rows)
    this.completion = ranked.completion
    this.waitForLate(text, ctx)
    return { seq: this.seq, count: this.rows.length, completion: this.completion }
  }

  /** The history's icon for each history row, which holds none of its own. */
  private withFavicons (rows: SuggestionRow[]): SuggestionRow[] {
    const hosts = [...new Set(rows.filter((row) => row.kind === 'history' && row.favicon == null && row.url !== undefined).map((row) => hostKey(row.url ?? '')))].filter((host) => host !== '')
    if (hosts.length === 0) return rows
    const icons = this.deps.faviconsFor(hosts)
    return rows.map((row) => row.kind === 'history' && row.favicon == null && row.url !== undefined ? { ...row, favicon: icons[hostKey(row.url)] ?? null } : row)
  }

  private waitForLate (text: string, ctx: SuggestContext): void {
    const sources = this.deps.lateSources ?? LATE_SOURCES
    if (sources.length === 0) return
    const controller = new AbortController()
    this.late = controller
    const seq = this.seq
    for (const source of sources) {
      source(text, ctx, controller.signal).then((rows) => {
        if (controller.signal.aborted || seq !== this.seq || rows.length === 0) return
        this.rows = placeLate(this.rows, rows, this.selected)
        this.deps.onLate(this.snapshot())
      }, () => {})
    }
  }

  snapshot (): Snapshot {
    return { seq: this.seq, rows: this.rows.map(pageRow), selected: this.selected }
  }

  /** Moves the selection one row, wrapping. `fill` is what the address bar shows for it: null for the first
   * row, where the typed text comes back. */
  select (step: 1 | -1, seq: number | undefined): { selected: number, fill: string | null } | undefined {
    if (seq !== undefined && seq !== this.seq) return undefined
    const count = this.rows.length
    if (count === 0) return undefined
    this.selected = (this.selected + step + count) % count
    return { selected: this.selected, fill: this.selected === 0 ? null : this.fillFor(this.selected) }
  }

  private fillFor (index: number): string | null {
    const row = this.rows[index]
    if (row === undefined) return null
    if (row.kind === 'search') return row.title
    return row.url ?? row.address
  }

  /** What choosing row `index` does, or undefined for a stale or impossible choice. */
  pick (index: number, disposition: Disposition, seq: number | undefined): Outcome | undefined {
    if (seq !== undefined && seq !== this.seq) return undefined
    const row = this.rows[index]
    if (row === undefined) return undefined
    if (row.kind === 'tab') return row.tabId === undefined ? undefined : { type: 'switch', tabId: row.tabId }
    if (row.url === undefined) return undefined
    const asTyped = row.kind === 'verbatim' || row.kind === 'search'
    const target = disposition === 'current' && asTyped && index === 0 ? this.text : row.url
    const existing = row.kind === 'history' || row.kind === 'bookmark' || row.kind === 'verbatim'
    return { type: 'go', disposition, target, markTyped: existing ? row.url : null }
  }

  /** The window's overlay closed or was left: nothing is held, and an answer still on its way is stale. */
  reset (): void {
    this.late?.abort()
    this.late = null
    this.seq += 1
    this.rows = []
    this.selected = 0
    this.completion = null
    this.text = ''
  }
}
