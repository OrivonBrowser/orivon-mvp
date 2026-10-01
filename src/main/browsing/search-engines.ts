// The search engines the address bar can send a query to, and the one rule
// for turning a query into a URL. Pure: no Electron, no Node.

export interface SearchEngine {
  readonly id: string
  readonly label: string
  /** Typed first in the address bar, before a space, to search this engine alone. Fixed: a person cannot change it. */
  readonly keyword: string
  /** `%s` marks where the query goes. */
  readonly template: string
  /** The https address the engine answers a typed prefix at, `%s` in place of it; absent when it has no public one. */
  readonly suggestUrl?: string
}

export const DEFAULT_SEARCH_ENGINE = 'duckduckgo'
/** The id under which the person's own template is used. */
export const CUSTOM_SEARCH_ENGINE = 'custom'

export const SEARCH_ENGINES: readonly SearchEngine[] = [
  { id: 'duckduckgo', label: 'DuckDuckGo', keyword: 'ddg', template: 'https://duckduckgo.com/?q=%s', suggestUrl: 'https://duckduckgo.com/ac/?q=%s&type=list' },
  { id: 'startpage', label: 'Startpage', keyword: 'sp', template: 'https://www.startpage.com/do/search?q=%s', suggestUrl: 'https://www.startpage.com/osuggestions?q=%s' },
  { id: 'brave', label: 'Brave Search', keyword: 'brave', template: 'https://search.brave.com/search?q=%s' },
  { id: 'ecosia', label: 'Ecosia', keyword: 'eco', template: 'https://www.ecosia.org/search?q=%s', suggestUrl: 'https://ac.ecosia.org/autocomplete?q=%s&type=list' },
  { id: 'qwant', label: 'Qwant', keyword: 'qw', template: 'https://www.qwant.com/?q=%s', suggestUrl: 'https://api.qwant.com/v3/suggest?q=%s' },
  { id: 'mojeek', label: 'Mojeek', keyword: 'mj', template: 'https://www.mojeek.com/search?q=%s' },
  { id: 'bing', label: 'Bing', keyword: 'bing', template: 'https://www.bing.com/search?q=%s', suggestUrl: 'https://api.bing.com/osjson.aspx?query=%s' },
  { id: 'google', label: 'Google', keyword: 'g', template: 'https://www.google.com/search?q=%s', suggestUrl: 'https://suggestqueries.google.com/complete/search?client=firefox&q=%s' }
]

const MAX_TEMPLATE_LENGTH = 2048

function isLoopbackHost (hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/** Whether a person's own template may be used. It must be https (http only
 * for a loopback host, for a search engine running on this machine), carry no
 * credentials, and put the query somewhere other than the host: a query typed
 * into the address bar must never choose which server is contacted. */
export function isValidSearchTemplate (template: string): boolean {
  if (template.length > MAX_TEMPLATE_LENGTH || !template.includes('%s')) return false
  const schemeEnd = template.indexOf('://')
  if (schemeEnd === -1) return false
  const authority = template.slice(schemeEnd + 3).split(/[/?#]/, 1)[0] ?? ''
  if (authority.includes('%s')) return false
  let url: URL
  try {
    url = new URL(template.split('%s').join('x'))
  } catch {
    return false
  }
  if (url.username !== '' || url.password !== '' || url.hostname === '') return false
  return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname))
}

/** The query as an `application/x-www-form-urlencoded` value, the encoding a
 * search box submits: a space is `+`. */
function encodeQuery (query: string): string {
  return new URLSearchParams({ q: query }).toString().slice(2)
}

/** `template` with `query` in place of `%s`. */
export function fillTemplate (template: string, query: string): string {
  return template.split('%s').join(encodeQuery(query))
}

/** The template the default choice stands for. An unknown engine, or `custom` with no usable template, falls
 * back to the first engine rather than to nothing. */
export function defaultTemplate (engineId: string, customTemplate: string): string {
  let template = SEARCH_ENGINES.find((engine) => engine.id === engineId)?.template
  if (engineId === CUSTOM_SEARCH_ENGINE && isValidSearchTemplate(customTemplate)) template = customTemplate
  return template ?? (SEARCH_ENGINES[0] as SearchEngine).template
}

/** The URL that searches for `query` with the default choice. */
export function searchUrlFor (engineId: string, customTemplate: string, query: string): string {
  return fillTemplate(defaultTemplate(engineId, customTemplate), query)
}
