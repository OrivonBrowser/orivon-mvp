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

export interface ProtocolDescriptor {
  /** Lowercase letters, digits and hyphens: `'ipfs'`. */
  readonly id: string
  /** Address schemes, shown as `<scheme>://<name>` and served at `https://<name>.<scheme>.orivon`. */
  readonly schemes: readonly string[]
  /** Top-level domains whose names it resolves, each served at the name itself: `https://<name>.eth`. */
  readonly topLevelDomains: readonly string[]
}

export interface Protocol {
  readonly descriptor: ProtocolDescriptor
  readonly resolvers: readonly NameResolver[]
  readonly gatherers: readonly DataGatherer[]
}

const ID = /^[a-z][a-z0-9-]{0,62}$/
/** A URL scheme that is also one DNS label, since it becomes a label of the host. */
const SCHEME = /^[a-z][a-z0-9]{0,30}$/
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

/** Checks a descriptor and returns it frozen. Throws for one the shell could not route or show. */
export function describeProtocol (descriptor: ProtocolDescriptor): ProtocolDescriptor {
  const { id, schemes, topLevelDomains } = descriptor
  if (!ID.test(id)) throw new Error(`protocol id ${JSON.stringify(id)} is not lowercase letters, digits and hyphens`)
  for (const scheme of schemes) {
    if (!SCHEME.test(scheme)) throw new Error(`protocol ${id}: scheme ${JSON.stringify(scheme)} is not lowercase letters and digits`)
    if (RESERVED_SCHEMES.has(scheme) || scheme.startsWith(ADDRESS_SUFFIX)) throw new Error(`protocol ${id}: scheme ${scheme} is reserved`)
  }
  for (const tld of topLevelDomains) {
    if (!TOP_LEVEL_DOMAIN.test(tld)) throw new Error(`protocol ${id}: ${JSON.stringify(tld)} is not a top-level domain`)
    if (RESERVED_TOP_LEVEL_DOMAINS.has(tld)) throw new Error(`protocol ${id}: .${tld} is reserved`)
  }
  const namespaces = namespacesOf(descriptor)
  if (namespaces.length === 0) throw new Error(`protocol ${id} serves no scheme and no top-level domain`)
  if (new Set(namespaces).size !== namespaces.length) throw new Error(`protocol ${id} declares a namespace twice`)
  return Object.freeze({ id, schemes: Object.freeze([...schemes]), topLevelDomains: Object.freeze([...topLevelDomains]) })
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
