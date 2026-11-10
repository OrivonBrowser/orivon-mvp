// The relay's lookup for a caller that checks an address before it reads: the same steps, through the same proxy entry the system
// names for the URL, as a relayed connection to it. Every address comes back, IPv4 first, so the caller judges all of them.
// Electron-free over the calls it is handed.

import { isIP } from 'node:net'
import { isOnionHost } from '../../../broker/route/onion.js'
import { BUILTIN_ADDRESSES } from '../../../protocols/builtin.js'
import { keepResolverOrder } from './addresses.js'
import { LookupRefusal } from './proxied-lookup.js'
import type { NameLookup } from './proxied-lookup.js'
import { onAnonymityPort, parseProxyAnswer } from './proxy-answer.js'
import { RelayRefusal } from './relay-failures.js'

/** The addresses `host` has for a connection to `url`, or a `RelayRefusal` saying why none could be had. */
export type RelayHostLookup = (host: string, url: string) => Promise<readonly string[]>

export interface RelayLookupDeps {
  /** Which proxy the system names for a URL: T20's `resolveProxy` string. */
  readonly systemAnswer: (url: string) => Promise<string>
  /** The lookup through a proxy, steps three and four of the relay's resolver. */
  readonly lookup: NameLookup
  /** The addresses this computer gives `host`, for a URL the system sends outside any proxy. A rejection counts as no address. */
  readonly lookupDirect: (host: string) => Promise<readonly string[]>
}

export function createRelayLookup (deps: RelayLookupDeps): RelayHostLookup {
  return async (host, url) => {
    const name = host.replace(/^\[(.*)\]$/, '$1')
    if (isOnionHost(name) || BUILTIN_ADDRESSES.namesServedHost(name)) throw new RelayRefusal('refused')
    if (isIP(name) !== 0) return [name]
    let answer
    try {
      answer = parseProxyAnswer(await deps.systemAnswer(url))
    } catch {
      throw new RelayRefusal('unsure')
    }
    switch (answer.kind) {
      case 'junk': throw new RelayRefusal('unsure')
      case 'refused': throw new RelayRefusal('refused')
      case 'direct': {
        const found = keepResolverOrder(await deps.lookupDirect(name).catch(() => []))
        if (found.length === 0) throw new RelayRefusal('not-found')
        return found
      }
      case 'proxies':
        if (answer.entries.some(onAnonymityPort)) throw new RelayRefusal('anonymity')
        for (const entry of answer.entries) {
          try {
            const found = await deps.lookup(name, { scheme: entry.kind, host: entry.host, port: entry.port })
            return [...found.addresses, ...(await found.more ?? [])]
          } catch (error) {
            const word = error instanceof LookupRefusal ? error.word : 'no-answer'
            // Only a proxy that cannot be passed through moves on to the next of the list, as a connection does.
            if (word !== 'unreachable') throw new RelayRefusal(word)
          }
        }
        throw new RelayRefusal('unreachable')
    }
  }
}
