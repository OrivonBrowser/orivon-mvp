// What a protocol is: the namespaces it serves, as plain data the shell can
// route and show, and the providers the verifier host runs for them.
// Rationale, and how to add one: README.md.

import type { DataGatherer, NameResolver, Namespace } from './resolution/providers.js'

/**
 * The one host suffix every address scheme is served under:
 * `https://<name>.<scheme>.orivon`. Routed to the verifier once, at launch,
 * so a scheme added later needs no new resolver rule.
 */
export const ADDRESS_SUFFIX = 'orivon'

/** What the shell says over a tab while one of a protocol's pages loads. The shell draws the screen; a protocol only words it. */
export interface LoadingScreen {
  /** One line, 1 to 48 characters. */
  readonly title: string
  /** A sentence under it, 1 to 140 characters. */
  readonly detail?: string
}

export interface ProtocolDescriptor {
  /** Lowercase letters, digits and hyphens: `'ipfs'`. */
  readonly id: string
  /** Address schemes, shown as `<scheme>://<name>` and served at `https://<name>.<scheme>.orivon`. */
  readonly schemes: readonly string[]
  /** Top-level domains whose names it resolves, each served at the name itself: `https://<name>.eth`. */
  readonly topLevelDomains: readonly string[]
  /** The address scheme a name under `topLevelDomains` is shown with (`ipfs` for `.eth`); its origin is unchanged. Requires `topLevelDomains` to be non-empty. */
  readonly displayScheme?: string
  /** Shown over a tab while a page of this protocol loads. A top-level-domain name whose protocol gives none uses its `displayScheme`'s protocol's. */
  readonly loadingScreen?: LoadingScreen
}

export interface Protocol {
  readonly descriptor: ProtocolDescriptor
  readonly resolvers: readonly NameResolver[]
  readonly gatherers: readonly DataGatherer[]
}

const ID = /^[a-z][a-z0-9-]{0,62}$/
/** A URL scheme that is also one DNS label, since it becomes a label of the host. */
const SCHEME = /^[a-z][a-z0-9]{0,30}$/
const LOADING_TITLE_LIMIT = 48
const LOADING_DETAIL_LIMIT = 140
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/
const TOP_LEVEL_DOMAIN = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/
/** Schemes the browser already means something by. Every scheme starting with `orivon` is Orivon's own. */
const RESERVED_SCHEMES: ReadonlySet<string> = new Set([
  'about', 'blob', 'chrome', 'data', 'devtools', 'file', 'filesystem', 'ftp', 'http', 'https',
  'javascript', 'mailto', 'view-source', 'ws', 'wss'
])
/** Special-use names Chromium or the network already route elsewhere, and the address suffix itself. */
const RESERVED_TOP_LEVEL_DOMAINS: ReadonlySet<string> = new Set(['internal', 'invalid', 'local', 'localhost', 'onion', 'test', ADDRESS_SUFFIX])

export function namespacesOf (descriptor: ProtocolDescriptor): Namespace[] {
  return [
    ...descriptor.topLevelDomains.map((tld): Namespace => `.${tld}`),
    ...descriptor.schemes.map((scheme): Namespace => `${scheme}:`)
  ]
}

/** `text` trimmed, or a thrown error naming `what` when it is empty, over `limit` or holds a control character. */
function loadingText (id: string, what: string, text: string, limit: number): string {
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.length > limit || CONTROL_CHARACTER.test(trimmed)) {
    throw new Error(`protocol ${id}: loadingScreen ${what} must be 1 to ${String(limit)} characters with no control character`)
  }
  return trimmed
}

function describeLoadingScreen (id: string, screen: LoadingScreen): LoadingScreen {
  const title = loadingText(id, 'title', screen.title, LOADING_TITLE_LIMIT)
  return Object.freeze(screen.detail === undefined ? { title } : { title, detail: loadingText(id, 'detail', screen.detail, LOADING_DETAIL_LIMIT) })
}

/** Checks a descriptor and returns it frozen. Throws for one the shell could not route or show. */
export function describeProtocol (descriptor: ProtocolDescriptor): ProtocolDescriptor {
  const { id, schemes, topLevelDomains, displayScheme, loadingScreen } = descriptor
  if (!ID.test(id)) throw new Error(`protocol id ${JSON.stringify(id)} is not lowercase letters, digits and hyphens`)
  for (const scheme of schemes) {
    if (!SCHEME.test(scheme)) throw new Error(`protocol ${id}: scheme ${JSON.stringify(scheme)} is not lowercase letters and digits`)
    if (RESERVED_SCHEMES.has(scheme) || scheme.startsWith(ADDRESS_SUFFIX)) throw new Error(`protocol ${id}: scheme ${scheme} is reserved`)
  }
  for (const tld of topLevelDomains) {
    if (!TOP_LEVEL_DOMAIN.test(tld)) throw new Error(`protocol ${id}: ${JSON.stringify(tld)} is not a top-level domain`)
    if (RESERVED_TOP_LEVEL_DOMAINS.has(tld)) throw new Error(`protocol ${id}: .${tld} is reserved`)
  }
  if (displayScheme !== undefined) {
    if (topLevelDomains.length === 0) throw new Error(`protocol ${id}: displayScheme needs a top-level domain to apply to`)
    if (!SCHEME.test(displayScheme)) throw new Error(`protocol ${id}: displayScheme ${JSON.stringify(displayScheme)} is not lowercase letters and digits`)
    if (RESERVED_SCHEMES.has(displayScheme) || displayScheme.startsWith(ADDRESS_SUFFIX)) throw new Error(`protocol ${id}: displayScheme ${displayScheme} is reserved`)
  }
  const namespaces = namespacesOf(descriptor)
  if (namespaces.length === 0) throw new Error(`protocol ${id} serves no scheme and no top-level domain`)
  if (new Set(namespaces).size !== namespaces.length) throw new Error(`protocol ${id} declares a namespace twice`)
  return Object.freeze({
    id,
    schemes: Object.freeze([...schemes]),
    topLevelDomains: Object.freeze([...topLevelDomains]),
    ...(displayScheme === undefined ? {} : { displayScheme }),
    ...(loadingScreen === undefined ? {} : { loadingScreen: describeLoadingScreen(id, loadingScreen) })
  })
}

/**
 * The one way a protocol is registered: its descriptor with the providers
 * that serve it. Throws when a resolver answers a namespace the descriptor
 * does not declare, because the shell routes and shows by the descriptor alone.
 */
export function defineProtocol (descriptor: ProtocolDescriptor, providers: { readonly resolvers?: readonly NameResolver[], readonly gatherers?: readonly DataGatherer[] }): Protocol {
  const checked = describeProtocol(descriptor)
  const declared = new Set(namespacesOf(checked))
  const resolvers = providers.resolvers ?? []
  for (const resolver of resolvers) {
    const stray = resolver.namespaces.find((namespace) => !declared.has(namespace))
    if (stray !== undefined) throw new Error(`protocol ${checked.id}: resolver ${resolver.id} answers ${stray}, which the protocol does not declare`)
  }
  return Object.freeze({ descriptor: checked, resolvers: [...resolvers], gatherers: [...providers.gatherers ?? []] })
}
