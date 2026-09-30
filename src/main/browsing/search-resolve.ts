// Which engine a typed search goes to, and the address that searches it. Pure: no Electron, no Node.
// `<keyword> <terms>` searches the engine that owns the keyword; anything else goes to the default.
import { defaultTemplate, fillTemplate } from './search-engines.js'

export type EngineKind = 'builtin' | 'site' | 'custom'

/** An engine as the address bar and Settings see it. */
export interface EngineView {
  readonly id: string
  readonly name: string
  readonly keyword: string
  /** `%s` marks where the terms go. */
  readonly template: string
  readonly kind: EngineKind
}

/** What a search with no keyword goes to. `name` is empty when the person's own address is not one of the engines. */
export interface DefaultEngine {
  readonly id: string
  readonly name: string
  readonly template: string
}

export interface ResolvedSearch {
  readonly engine: { readonly id: string, readonly name: string }
  /** What the engine is asked for: the text without its keyword. */
  readonly terms: string
  readonly url: string
  /** The text began with an engine's keyword. */
  readonly byKeyword: boolean
}

/** The default choice as an engine. The name comes from the engine whose address it is, so a site engine made
 * the default is still called by its name. */
export function defaultEngineFor (engineId: string, customTemplate: string, engines: readonly EngineView[]): DefaultEngine {
  const template = defaultTemplate(engineId, customTemplate)
  const match = engines.find((engine) => engine.template === template)
  return { id: match?.id ?? engineId, name: match?.name ?? '', template }
}

/** Only a whole first word followed by more text is a keyword: `w` alone and `w.com` are not searches of an
 * engine, so a keyword never takes the place of an address. */
function splitKeyword (query: string): { keyword: string, rest: string } | null {
  const match = /^(\S+)\s+(\S[\s\S]*)$/.exec(query)
  return match === null ? null : { keyword: (match[1] ?? '').toLowerCase(), rest: match[2] ?? '' }
}

export function resolveSearch (query: string, engines: readonly EngineView[], fallback: DefaultEngine): ResolvedSearch {
  const text = query.trim()
  const split = splitKeyword(text)
  if (split !== null) {
    const engine = engines.find((candidate) => candidate.keyword.toLowerCase() === split.keyword)
    if (engine !== undefined) {
      const terms = split.rest.trim()
      return { engine: { id: engine.id, name: engine.name }, terms, url: fillTemplate(engine.template, terms), byKeyword: true }
    }
  }
  return { engine: { id: fallback.id, name: fallback.name }, terms: text, url: fillTemplate(fallback.template, text), byKeyword: false }
}
