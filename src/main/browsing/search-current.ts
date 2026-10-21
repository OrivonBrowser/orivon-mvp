// The search the address bar does right now: the engines the profile keeps and the default its settings name,
// put together once so the tab's Enter, the dropdown's first row, the page menu's selection search and
// `chrome.search.query` cannot disagree. `search.mode` picks the list the default comes from: Web3 (an engine that
// searches sites on `ipfs://` and ENS names) or Web2 (the https engines). Pure: what it needs from the shell arrives
// as two narrow parts.
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { defaultTemplate, fillTemplate, web3EngineFor } from './search-engines.js'
import type { Web3SearchEngine } from './search-engines.js'
import { defaultEngineFor, resolveSearch } from './search-resolve.js'
import type { DefaultEngine, EngineView, ResolvedSearch } from './search-resolve.js'

/** A tab loads a protocol's address from the https address it is served at, as for a typed one (./omnibox.ts); the
 * Web3 engine's template is such an address, and the tab still shows it as the protocol's own. */
const loadable = (url: string): string => BUILTIN_ADDRESSES.servedUrl(url) ?? url

export type SearchSettingKey = 'search.engine' | 'search.customUrl' | 'search.mode' | 'search.web3Engine'

export interface SearchSettings {
  readonly get: (key: SearchSettingKey) => string
}

export interface SearchSources {
  readonly settings: SearchSettings
  readonly searchEngines: { all: () => readonly EngineView[] }
}

/** The Web3 engine searches go to now; null in Web2 mode. */
export function web3EngineNow (settings: SearchSettings): Web3SearchEngine | null {
  return settings.get('search.mode') === 'web3' ? web3EngineFor(settings.get('search.web3Engine')) : null
}

/** The address that searches `query` with the current default, from settings alone. */
export function currentSearchUrl (settings: SearchSettings, query: string): string {
  const web3 = web3EngineNow(settings)
  return loadable(fillTemplate(web3?.template ?? defaultTemplate(settings.get('search.engine'), settings.get('search.customUrl')), query))
}

export function currentDefault (sources: SearchSources, engines: readonly EngineView[] = sources.searchEngines.all()): DefaultEngine {
  const web3 = web3EngineNow(sources.settings)
  if (web3 !== null) return { id: web3.id, name: web3.label, template: web3.template }
  return defaultEngineFor(sources.settings.get('search.engine'), sources.settings.get('search.customUrl'), engines)
}

/** The name each mode's engine goes by, for a control that offers the other one; empty for a Web2 address that is none of the engines. */
export function engineNames (sources: SearchSources): { readonly web3: string, readonly web2: string } {
  const { settings } = sources
  return {
    web3: web3EngineFor(settings.get('search.web3Engine')).label,
    web2: defaultEngineFor(settings.get('search.engine'), settings.get('search.customUrl'), sources.searchEngines.all()).name
  }
}

export function resolveCurrent (sources: SearchSources, query: string): ResolvedSearch {
  const engines = sources.searchEngines.all()
  const resolved = resolveSearch(query, engines, currentDefault(sources, engines))
  return { ...resolved, url: loadable(resolved.url) }
}
