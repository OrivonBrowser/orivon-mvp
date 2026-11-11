// The opener behind the name relay's listener (`front.ts`'s `open`): for a target it asks the system which proxy applies, looks
// the name up through that proxy, and opens the upstream to an address. A routed or onion name is refused before anything is
// asked, a lookup never leaves outside the proxy that carries the connection, and a `DIRECT` after a proxy is never taken. It
// returns the stream paused, or rejects with a `RelayRefusal`. Electron-free over the calls it is handed.

import { isIP } from 'node:net'
import type { Socket } from 'node:net'
import { isOnionHost, ONION_NEEDS_TOR } from '../../../broker/route/onion.js'
import { BUILTIN_ADDRESSES } from '../../../protocols/builtin.js'
import { ROUTED_NAME_NOT_CARRIED } from '../front.js'
import type { FrontTarget } from '../front.js'
import { keepResolverOrder, MAX_ADDRESSES, orderForProxy } from './addresses.js'
import { onAnonymityPort, parseProxyAnswer, stricterAnswer } from './proxy-answer.js'
import type { ProxyAnswer } from './proxy-answer.js'
import { LookupRefusal } from './proxied-lookup.js'
import type { LookupAnswer, NameLookup, ProxyEntry } from './proxied-lookup.js'
import { RelayRefusal } from './relay-failures.js'
import type { RelayFailures } from './relay-failures.js'
import { abandoned, connectDirect, connectThroughProxy, UpstreamFailure } from './upstream.js'
import type { UpstreamOptions } from './upstream.js'

/** How many connections the relay carries at once, the opening ones included. */
export const RELAY_MAX_OPEN = 512

/** The addresses this computer gives `host`, for a connection the system sends outside any proxy. A rejection counts as no address. */
export type DirectLookup = (host: string, signal: AbortSignal) => Promise<readonly string[]>

export interface RelayOpenerDeps {
  /** Which proxy the system names for a URL: T20's `resolveProxy` string. */
  readonly systemAnswer: (url: string) => Promise<string>
  /** Looks a name up through the proxy it will leave by: IPv4 first, and the IPv6 addresses in `more` when the answer did not wait for them. A `LookupRefusal` with `unreachable` says the proxy cannot be passed through, and the next of the list is tried. */
  readonly lookup: NameLookup
  /** Forgets what the lookup knows of `host` through `via`, for a connection whose every address failed. */
  readonly drop: (host: string, via: ProxyEntry) => void
  readonly lookupDirect: DirectLookup
  readonly failures: RelayFailures
  readonly maxOpen?: number
  readonly upstream?: UpstreamOptions
  /** Called once for each connection made, with the address it was made to and the road: the proxy's word (`PROXY`, `HTTPS`, `SOCKS5`, `SOCKS`) or `DIRECT`. */
  readonly connected?: (target: FrontTarget, address: string, road: string) => void
}

/** The proxy's own word for a road, as the system writes it: all a report of a connection may say of the proxy. */
const ROAD: Readonly<Record<ProxyEntry['scheme'], string>> = { http: 'PROXY', https: 'HTTPS', socks5: 'SOCKS5', socks4: 'SOCKS' }

const BUSY = 'Orivon is already carrying as many connections through your proxy as it allows. Try again in a moment.'

/**
 * The target with the host of its URL, bracket-free: the name Chromium dials and the one the system is asked about, not the text
 * written on the request line (`0x7f.1` is 127.0.0.1 and `Shop.Example` is shop.example), so every decision, the lookup and the
 * failure memory included, is made on one spelling. Undefined for a URL that has no host.
 */
function asChromiumReads (target: FrontTarget): FrontTarget | undefined {
  try {
    const { hostname } = new URL(target.url)
    return hostname === '' ? undefined : { ...target, host: hostname.startsWith('[') ? hostname.slice(1, -1) : hostname }
  } catch {
    return undefined
  }
}

/** This proxy cannot be used, and the next of the list is worth a try. */
class ProxyDown extends Error {}

async function untilAbandoned<T> (work: Promise<T>, signal: AbortSignal): Promise<T> {
  return await new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abandoned()); return }
    const onAbort = (): void => { reject(abandoned()) }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => { signal.removeEventListener('abort', onAbort) })
  })
}

/** The addresses of a round of the answer; a round that fails to arrive has none. */
async function addressesOf (round: Promise<readonly string[]>, signal: AbortSignal): Promise<readonly string[]> {
  try {
    return await untilAbandoned(round, signal)
  } catch {
    if (signal.aborted) throw abandoned()
    return []
  }
}

export function createRelayOpener (deps: RelayOpenerDeps): (target: FrontTarget) => Promise<Socket> {
  const maxOpen = deps.maxOpen ?? RELAY_MAX_OPEN
  let active = 0

  /** Nothing a listener does with the report ends the connection it reports. */
  function report (target: FrontTarget, address: string, road: string): void {
    try {
      deps.connected?.(target, address, road)
    } catch {
      // The connection is made; a listener that fails is its own.
    }
  }

  /** What the lookup found for `host` through `entry`, or why it found nothing. */
  async function lookUp (host: string, entry: ProxyEntry, signal: AbortSignal): Promise<LookupAnswer> {
    try {
      return await untilAbandoned((async () => await deps.lookup(host, entry))(), signal)
    } catch (error) {
      if (signal.aborted) throw abandoned()
      const word = error instanceof LookupRefusal ? error.word : 'no-answer'
      if (word === 'unreachable') throw new ProxyDown()
      throw new RelayRefusal(word)
    }
  }

  async function throughProxy (target: FrontTarget, entry: ProxyEntry): Promise<Socket> {
    const { host, port, signal } = target
    const named = isIP(host) === 0
    const found: LookupAnswer = named ? await lookUp(host, entry, signal) : { addresses: [host] }
    const rounds = [Promise.resolve(found.addresses), ...(found.more === undefined ? [] : [found.more])]
    let tried = 0
    let inside = 0
    let unsupported = 0
    // The IPv6 addresses are awaited only once the IPv4 ones have failed, so the first answer to arrive starts the connecting.
    for (const round of rounds) {
      const answered = await addressesOf(round, signal)
      // SOCKS4 carries IPv4 only.
      const carried = entry.scheme === 'socks4' ? answered.filter((address) => isIP(address) === 4) : answered
      unsupported += answered.length - carried.length
      const ordered = orderForProxy(carried, MAX_ADDRESSES - tried)
      inside += ordered.inside
      for (const address of ordered.usable) {
        tried += 1
        let socket: Socket
        try {
          socket = await connectThroughProxy(entry, address, port, signal, deps.upstream)
        } catch (error) {
          if (signal.aborted) throw abandoned()
          if (!(error instanceof UpstreamFailure)) throw new RelayRefusal('unreachable')
          if (error.effect === 'proxy') throw new ProxyDown()
          if (error.effect === 'final') throw new RelayRefusal(error.word)
          continue
        }
        report(target, address, ROAD[entry.scheme])
        return socket
      }
    }
    if (tried > 0) {
      if (named) deps.drop(host, entry)
      throw new RelayRefusal('unreachable')
    }
    if (inside > 0) throw new RelayRefusal('inside')
    throw new RelayRefusal(unsupported > 0 ? 'unreachable' : 'not-found')
  }

  async function openDirect (target: FrontTarget): Promise<Socket> {
    const { host, port, signal } = target
    const found = isIP(host) !== 0 ? [host] : await untilAbandoned((async () => await deps.lookupDirect(host, signal))().catch(() => []), signal)
    const addresses = keepResolverOrder(found)
    if (addresses.length === 0) throw new RelayRefusal('not-found')
    for (const address of addresses) {
      let socket: Socket
      try {
        socket = await connectDirect(address, port, signal, deps.upstream)
      } catch {
        if (signal.aborted) throw abandoned()
        continue
      }
      report(target, address, 'DIRECT')
      return socket
    }
    throw new RelayRefusal('unreachable')
  }

  async function connect (target: FrontTarget): Promise<Socket> {
    if (isOnionHost(target.host)) throw new RelayRefusal('refused', 403, ONION_NEEDS_TOR)
    if (BUILTIN_ADDRESSES.namesServedHost(target.host)) throw new RelayRefusal('refused', 403, ROUTED_NAME_NOT_CARRIED)
    let answer: ProxyAnswer
    try {
      answer = parseProxyAnswer(await deps.systemAnswer(target.url))
      // The other URLs the connection may be for are asked only while no proxy has been named: a proxy is taken whenever one URL names it.
      for (const url of target.alsoAsk ?? []) {
        if (answer.kind === 'proxies') break
        answer = stricterAnswer(answer, parseProxyAnswer(await deps.systemAnswer(url)))
      }
    } catch {
      throw new RelayRefusal('unsure')
    }
    switch (answer.kind) {
      case 'junk': throw new RelayRefusal('unsure')
      case 'refused': throw new RelayRefusal('refused')
      case 'direct': return await openDirect(target)
      case 'proxies':
        if (answer.entries.some(onAnonymityPort)) throw new RelayRefusal('anonymity')
        for (const entry of answer.entries) {
          try {
            return await throughProxy(target, entry)
          } catch (error) {
            if (!(error instanceof ProxyDown)) throw error
          }
        }
        throw new RelayRefusal('unreachable')
    }
  }

  function note (target: FrontTarget, error: unknown): void {
    if (error instanceof RelayRefusal && !target.signal.aborted) deps.failures.note(target.host, target.port, error.word)
  }

  return async (asked) => {
    const target = asChromiumReads(asked)
    if (target === undefined) throw new RelayRefusal('refused')
    if (active >= maxOpen) {
      const refusal = new RelayRefusal('refused', 503, BUSY)
      note(target, refusal)
      throw refusal
    }
    active += 1
    let counted = true
    const release = (): void => { if (counted) { counted = false; active -= 1 } }
    try {
      const socket = await connect(target)
      if (socket.destroyed) release()
      else socket.once('close', release)
      return socket
    } catch (error) {
      release()
      note(target, error)
      throw error
    }
  }
}
