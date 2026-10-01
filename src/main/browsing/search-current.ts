// The search the address bar does right now: the engines the profile keeps and the default its settings name,
// put together once so the tab's Enter and the dropdown's first row cannot disagree. Pure: what it needs from
// the shell arrives as two narrow parts.
import { defaultEngineFor, resolveSearch } from './search-resolve.js'
import type { DefaultEngine, EngineView, ResolvedSearch } from './search-resolve.js'

export interface SearchSources {
  readonly settings: { get: (key: 'search.engine' | 'search.customUrl') => string }
  readonly searchEngines: { all: () => readonly EngineView[] }
}

export function currentDefault (sources: SearchSources, engines: readonly EngineView[] = sources.searchEngines.all()): DefaultEngine {
  return defaultEngineFor(sources.settings.get('search.engine'), sources.settings.get('search.customUrl'), engines)
}

export function resolveCurrent (sources: SearchSources, query: string): ResolvedSearch {
  const engines = sources.searchEngines.all()
  return resolveSearch(query, engines, currentDefault(sources, engines))
}
