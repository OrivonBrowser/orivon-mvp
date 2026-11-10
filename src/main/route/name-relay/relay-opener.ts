// The opener behind the name relay's listener (`front.ts`'s `open`): for a target it asks the system which proxy applies, looks
// the name up through that proxy, and opens the upstream to an address. A routed or onion name is refused before anything is
// asked, a lookup never leaves outside the proxy that carries the connection, and a `DIRECT` after a proxy is never taken. It
// returns the stream paused, or rejects with a `RelayRefusal`. Electron-free over the calls it is handed.

import { isIP } from 'node:net'
import type { Socket } from 'node:net'
import { isOnionHost, ONION_NEEDS_TOR } from '../../../broker/route/onion.js'
import { BUILTIN_ADDRESSES } from '../../../protocols/builtin.js'
import type { FrontTarget } from '../front.js'
import { keepResolverOrder, MAX_ADDRESSES, orderForProxy } from './addresses.js'
import { onAnonymityPort, parseProxyAnswer } from './proxy-answer.js'
import type { ProxyAnswer, ProxyEntry } from './proxy-answer.js'
import { RelayRefusal } from './relay-failures.js'
import type { RelayFailures } from './relay-failures.js'
import { abandoned, connectDirect, connectThroughProxy, UpstreamFailure } from './upstream.js'
import type { UpstreamOptions } from './upstream.js'

/** How many connections the relay carries at once, the opening ones included. */
export const RELAY_MAX_OPEN = 512

export interface RelayLookupQuery {
  readonly host: string
  readonly family: 4 | 6
  /** The proxy the connection will leave by: the lookup is sent through it and answered for where it leaves. */
  readonly via: ProxyEntry
  readonly signal: AbortSignal
}

/**
 * The addresses `host` has in one family, empty when it has none. It rejects with a `RelayRefusal` to say why it could not
 * answer: `not-found`, `no-answer`, `sign-in`, or `unreachable` when `via` cannot be passed through (the next proxy of the
 * list is tried); any other rejection counts as `no-answer`.
 */
export type RelayLookup = (query: RelayLookupQuery) => Promise<readonly string[]>

/** The addresses this computer gives `host`, for a connection the system sends outside any proxy. A rejection counts as no address. */
export type DirectLookup = (host: string, signal: AbortSignal) => Promise<readonly string[]>

export interface RelayOpenerDeps {
  /** Which proxy the system names for a URL: T20's `resolveProxy` string. */
  readonly systemAnswer: (url: string) => Promise<string>
  readonly lookup: RelayLookup
  readonly lookupDirect: DirectLookup
  readonly failures: RelayFailures
  readonly maxOpen?: number
  readonly upstream?: UpstreamOptions
}

const ROUTED_NAME = 'Orivon opens this name itself, so it is never sent through your proxy.'
const BUSY = 'Orivon is already carrying as many connections through your proxy as it allows. Try again in a moment.'

/** This proxy cannot be used, and the next of the list is worth a try. */
class ProxyDown extends Error {}

/** What a lookup of one family came to; it never rejects. */
type Settled = { readonly addresses: readonly string[] } | { readonly refusal: RelayRefusal }

async function untilAbandoned<T> (work: Promise<T>, signal: AbortSignal): Promise<T> {
  return await new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abandoned()); return }
    const onAbort = (): void => { reject(abandoned()) }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => { signal.removeEventListener('abort', onAbort) })
  })
}

async function settle (ask: () => Promise<readonly string[]>, signal: AbortSignal): Promise<Settled> {
  try {
    return { addresses: await untilAbandoned(ask(), signal) }
  } catch (error) {
    return { refusal: error instanceof RelayRefusal ? error : new RelayRefusal('no-answer') }
  }
}

export function createRelayOpener (deps: RelayOpenerDeps): (target: FrontTarget) => Promise<Socket> {
  const maxOpen = deps.maxOpen ?? RELAY_MAX_OPEN
  let active = 0

  async function throughProxy (target: FrontTarget, entry: ProxyEntry): Promise<Socket> {
    const { host, port, signal } = target
    // SOCKS4 carries IPv4 only, so an IPv6 lookup would be asked for nothing.
    const families: Array<Promise<Settled>> = isIP(host) !== 0
      ? [Promise.resolve({ addresses: [host] })]
      : (entry.kind === 'socks4' ? [4 as const] : [4 as const, 6 as const]).map((family) => settle(async () => await deps.lookup({ host, family, via: entry, signal }), signal))
    let tried = 0
    let inside = 0
    const refusals: RelayRefusal[] = []
    // A family is awaited only once the addresses before it have failed, so the first answer to arrive starts the connecting.
    for (const family of families) {
      const settled = await family
      if (signal.aborted) throw abandoned()
      if ('refusal' in settled) { refusals.push(settled.refusal); continue }
      const ordered = orderForProxy(settled.addresses, MAX_ADDRESSES - tried)
      inside += ordered.inside
      for (const address of ordered.usable) {
        tried += 1
        try {
          return await connectThroughProxy(entry, address, port, signal, deps.upstream)
        } catch (error) {
          if (signal.aborted) throw abandoned()
          if (!(error instanceof UpstreamFailure)) throw new RelayRefusal('unreachable')
          if (error.effect === 'proxy') throw new ProxyDown()
          if (error.effect === 'final') throw new RelayRefusal(error.word)
        }
      }
    }
    if (tried > 0) throw new RelayRefusal('unreachable')
    if (inside > 0) throw new RelayRefusal('inside')
    const unanswered = refusals.find((refusal) => refusal.word !== 'not-found')
    if (unanswered?.word === 'unreachable') throw new ProxyDown()
    throw unanswered ?? new RelayRefusal('not-found')
  }

  async function openDirect (target: FrontTarget): Promise<Socket> {
    const { host, port, signal } = target
    const found = isIP(host) !== 0 ? [host] : await untilAbandoned(deps.lookupDirect(host, signal).catch(() => []), signal)
    const addresses = keepResolverOrder(found)
    if (addresses.length === 0) throw new RelayRefusal('not-found')
    for (const address of addresses) {
      try {
        return await connectDirect(address, port, signal, deps.upstream)
      } catch {
        if (signal.aborted) throw abandoned()
      }
    }
    throw new RelayRefusal('unreachable')
  }

  async function connect (target: FrontTarget): Promise<Socket> {
    if (isOnionHost(target.host)) throw new RelayRefusal('refused', 403, ONION_NEEDS_TOR)
    if (BUILTIN_ADDRESSES.namesServedHost(target.host)) throw new RelayRefusal('refused', 403, ROUTED_NAME)
    let answer: ProxyAnswer
    try {
      answer = parseProxyAnswer(await deps.systemAnswer(target.url))
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

  return async (target) => {
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
