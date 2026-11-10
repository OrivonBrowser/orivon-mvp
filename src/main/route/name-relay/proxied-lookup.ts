// The address of a site's name, looked up through the proxy that will carry the connection and never from this computer:
// a DNS-over-HTTPS query sent with `fetch` from a session of the relay's own, set to that one proxy with no direct
// fallback. A name that cannot be looked up that way is refused; no other resolver and no second provider is asked.
// Tied to Electron through the sessions it is handed. README.md has why.

import { isIP } from 'node:net'
import type { Session } from 'electron'
import { isOnionHost } from '../../../broker/route/onion.js'
import { BUILTIN_ADDRESSES } from '../../../protocols/builtin.js'
import type { SecureDnsValue } from '../../privacy/secure-dns.js'
import { markOwnProxy } from '../own-proxy.js'
import { dohQuery, readDohAnswer } from './doh-message.js'
import type { AddressFamily } from './doh-message.js'
import { createNameCache } from './name-cache.js'
import type { CachedResult, Fetched, NameCache } from './name-cache.js'
import { dohUrlOverride } from './name-relay-test-seam.js'

/** A proxy the system names, as the URL scheme a session's proxy rules give it (`SOCKS` is `socks4`). */
export interface ProxyEntry {
  readonly scheme: 'http' | 'https' | 'socks5' | 'socks4'
  /** A name, or an IP literal without brackets. */
  readonly host: string
  readonly port: number
}

/** Why a name was not looked up. The words are all a log or a report may carry. */
export type LookupWord = 'not-found' | 'no-answer' | 'unreachable' | 'sign-in' | 'refused'

export class LookupRefusal extends Error {
  readonly word: LookupWord
  constructor (word: LookupWord) {
    super(word)
    this.name = 'LookupRefusal'
    this.word = word
  }
}

/** The addresses found, IPv4 first. When the answer did not wait for the other family, `more` holds its addresses; it never rejects. */
export interface LookupAnswer {
  readonly addresses: readonly string[]
  readonly more?: Promise<readonly string[]>
}

/** Looks `host` up through the proxy `via`, or rejects with a `LookupRefusal`. */
export type NameLookup = (host: string, via: ProxyEntry) => Promise<LookupAnswer>

export interface ProxiedLookup {
  readonly lookup: NameLookup
  /** Forgets what is known of `host` through `via`, as when every address it gave failed. */
  readonly drop: (host: string, via: ProxyEntry) => void
  /** Forgets every answer. */
  readonly clear: () => void
  /** Forgets every answer and closes the sessions' connections. */
  readonly close: () => Promise<void>
}

export type LookupSession = Pick<Session, 'fetch' | 'resolveHost' | 'setProxy' | 'setUserAgent' | 'closeAllConnections'>

export interface ProxiedLookupOptions {
  /** An in-memory session by the name given. Called at most four times, ever. */
  readonly makeSession: (partition: string) => LookupSession
  /** Read at every lookup, so a changed setting applies to the next one. */
  readonly secureDns: () => SecureDnsValue
  readonly cache?: NameCache
  readonly queryTimeoutMs?: number
  /** The server to ask instead of the provider's, for a test build. */
  readonly dohUrl?: () => string | undefined
}

export type DohProvider = 'quad9' | 'cloudflare'

/** The provider a Secure DNS value names. This computer's DNS cannot be asked through a proxy, so `off` and `automatic` (which would ask whatever the network offers) use Quad9. */
export function providerFor (value: SecureDnsValue): DohProvider {
  return value === 'cloudflare' ? 'cloudflare' : 'quad9'
}

const BY_NAME: Readonly<Record<DohProvider, string>> = { quad9: 'https://dns.quad9.net/dns-query', cloudflare: 'https://cloudflare-dns.com/dns-query' }
/** Chromium's SOCKS4 looks a name up on this computer first, so through it the server is named by address (its certificate lists these). */
const BY_ADDRESS: Readonly<Record<DohProvider, string>> = { quad9: 'https://9.9.9.9/dns-query', cloudflare: 'https://1.1.1.1/dns-query' }

const MAX_SESSIONS = 4
const QUERY_TIMEOUT_MS = 5000
/** Every lookup session says the same, so the server cannot tell people behind one proxy apart by it. */
const USER_AGENT = 'Mozilla/5.0'
const ACCEPT_LANGUAGE = 'en-US,en'

const SIGN_IN = /^ERR_(PROXY_AUTH_(UNSUPPORTED|REQUESTED)|UNEXPECTED_PROXY_AUTH)$/
const PROXY_FAILED = /^ERR_(PROXY_[A-Z_]+|TUNNEL_CONNECTION_FAILED|SOCKS_CONNECTION_[A-Z_]+|NO_SUPPORTED_PROXIES|CONNECTION_(REFUSED|RESET|CLOSED|TIMED_OUT)|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|NETWORK_ACCESS_DENIED)$/
const HOST_NAME = /^[a-z0-9_]([a-z0-9._-]*[a-z0-9_])?$/i

const errorCode = (error: unknown): string | undefined => /ERR_[A-Z0-9_]+/.exec(error instanceof Error ? error.message : '')?.[0]

/** What a failed request means for the lookup. */
function refusalOf (error: unknown): LookupRefusal {
  if (error instanceof LookupRefusal) return error
  const code = errorCode(error) ?? ''
  if (SIGN_IN.test(code)) return new LookupRefusal('sign-in')
  return new LookupRefusal(PROXY_FAILED.test(code) ? 'unreachable' : 'no-answer')
}

const wordOf = (error: unknown): LookupWord => refusalOf(error).word

/** The proxy rules for one entry, which must not be able to carry a second rule: a name with `;` or `,` in it could add a `direct://` one. */
function entryText (via: ProxyEntry): string {
  const bare = isIP(via.host) === 0
  if (!['http', 'https', 'socks5', 'socks4'].includes(via.scheme) || !Number.isInteger(via.port) || via.port < 1 || via.port > 65535 || (bare && !HOST_NAME.test(via.host))) {
    throw new LookupRefusal('unreachable')
  }
  return `${via.scheme}://${isIP(via.host) === 6 ? `[${via.host}]` : via.host}:${String(via.port)}`
}

const normalise = (host: string): string => host.replace(/^\[(.*)\]$/, '$1').toLowerCase().replace(/\.+$/, '')

/** IPv4 addresses first, then IPv6, each in the order given. */
const ipv4First = (addresses: readonly string[]): string[] => [...addresses.filter((address) => isIP(address) === 4), ...addresses.filter((address) => isIP(address) !== 4)]

interface Slot {
  readonly number: number
  readonly session: LookupSession
  readonly ready: Promise<void>
  /** Set while the first query of the session is out, and holds the word it failed with. */
  settling?: Promise<LookupWord | undefined> | undefined
}

type Settled = { readonly value: CachedResult } | { readonly error: unknown }

export function createProxiedLookup (options: ProxiedLookupOptions): ProxiedLookup {
  const cache = options.cache ?? createNameCache()
  const timeoutMs = options.queryTimeoutMs ?? QUERY_TIMEOUT_MS
  const dohUrl = options.dohUrl ?? dohUrlOverride
  const sessions = new Map<number, LookupSession>()
  // Least recently used first.
  const slots = new Map<string, Slot>()

  /** The number of the session a new entry takes: a free one, or that of the entry used longest ago, whose connections are closed. */
  function takeNumber (): number {
    if (slots.size < MAX_SESSIONS) {
      const taken = new Set([...slots.values()].map((slot) => slot.number))
      let number = 1
      while (taken.has(number)) number += 1
      return number
    }
    const [text, oldest] = slots.entries().next().value as [string, Slot]
    slots.delete(text)
    void Promise.resolve().then(async () => { await oldest.session.closeAllConnections() }).catch(() => {})
    return oldest.number
  }

  async function slotFor (via: ProxyEntry): Promise<Slot> {
    const text = entryText(via)
    let slot = slots.get(text)
    if (slot !== undefined) {
      slots.delete(text)
    } else {
      const number = takeNumber()
      let session = sessions.get(number)
      if (session === undefined) {
        session = options.makeSession(`orivon-name-lookup-${String(number)}`)
        markOwnProxy(session)
        session.setUserAgent(USER_AGENT, ACCEPT_LANGUAGE)
        sessions.set(number, session)
      }
      const ready = Promise.resolve().then(async () => { await session.setProxy({ mode: 'fixed_servers', proxyRules: text, proxyBypassRules: '' }) })
      slot = { number, session, ready }
    }
    slots.set(text, slot)
    try {
      await slot.ready
    } catch {
      if (slots.get(text) === slot) slots.delete(text)
      throw new LookupRefusal('unreachable')
    }
    return slot
  }

  /** What this computer alone knows of the name: a resolver rule or the hosts file. Chromium answers `ERR_DNS_CACHE_MISS` for the rest, without a packet. */
  async function ownMappings (session: LookupSession, name: string): Promise<string[]> {
    try {
      const { endpoints } = await session.resolveHost(name, { source: 'localOnly', cacheUsage: 'disallowed' })
      return ipv4First(endpoints.map((endpoint) => endpoint.address))
    } catch (error) {
      if (errorCode(error) === 'ERR_NAME_NOT_RESOLVED') throw new LookupRefusal('not-found')
      return []
    }
  }

  async function sendOnce (session: LookupSession, url: string, body: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    const abort = new AbortController()
    const timer = setTimeout(() => { abort.abort() }, timeoutMs)
    try {
      const response = await session.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/dns-message', accept: 'application/dns-message' },
        body,
        cache: 'no-store',
        credentials: 'omit',
        signal: abort.signal
      })
      if (response.status === 407) throw new LookupRefusal('sign-in')
      if (response.status !== 200) throw new LookupRefusal('no-answer')
      return new Uint8Array(await response.arrayBuffer())
    } finally {
      clearTimeout(timer)
    }
  }

  /** The first request after a network change can fail once with `ERR_NETWORK_CHANGED`; a second answers. */
  async function send (session: LookupSession, url: string, body: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    let failure: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await sendOnce(session, url, body)
      } catch (error) {
        failure = error
        if (errorCode(error) !== 'ERR_NETWORK_CHANGED') break
      }
    }
    throw refusalOf(failure)
  }

  /** Runs `work`, but waits for the first query of a session to end before sending another: two sent before the first tunnel is up open two. A first that failed because the proxy cannot be reached or asks for a sign-in fails the ones that waited as well. */
  async function afterFirst (slot: Slot, work: () => Promise<Uint8Array>): Promise<Uint8Array> {
    const earlier = slot.settling
    if (earlier !== undefined) {
      const word = await earlier
      if (word === 'unreachable' || word === 'sign-in') throw new LookupRefusal(word)
    }
    const run = work()
    if (earlier === undefined) {
      const settling = run.then(() => undefined, wordOf)
      slot.settling = settling
      void settling.then(() => { if (slot.settling === settling) slot.settling = undefined })
    }
    return await run
  }

  async function query (slot: Slot, name: string, family: AddressFamily, provider: DohProvider, via: ProxyEntry): Promise<Fetched> {
    const url = dohUrl() ?? (via.scheme === 'socks4' ? BY_ADDRESS : BY_NAME)[provider]
    const bytes = await afterFirst(slot, async () => await send(slot.session, url, dohQuery(name, family)))
    const answer = readDohAnswer(bytes, name, family)
    if (answer.kind === 'failed') throw new LookupRefusal('no-answer')
    return answer.kind === 'addresses' ? { addresses: answer.addresses, nxdomain: false, ttl: answer.ttl } : { addresses: [], nxdomain: answer.nxdomain, ttl: answer.ttl }
  }

  /** Why neither family gave an address. */
  function refusalFor (results: readonly Settled[]): LookupRefusal {
    if (results.some((result) => 'value' in result && result.value.nxdomain)) return new LookupRefusal('not-found')
    const words = results.flatMap((result) => ('error' in result ? [wordOf(result.error)] : []))
    for (const word of ['sign-in', 'unreachable', 'no-answer'] as const) if (words.includes(word)) return new LookupRefusal(word)
    return new LookupRefusal('not-found')
  }

  async function overDoh (slot: Slot, name: string, via: ProxyEntry): Promise<LookupAnswer> {
    const provider = providerFor(options.secureDns())
    const text = entryText(via)
    const ask = async (family: AddressFamily): Promise<Settled> => {
      try {
        return { value: await cache.get({ name, family, provider, via: text }, async () => await query(slot, name, family, provider, via)) }
      } catch (error) {
        return { error }
      }
    }
    const four = ask(4)
    const six = ask(6)
    const first = await four
    // Toward a proxy IPv4 comes first, so the connection starts as soon as it is known and IPv6 stays for failover.
    if ('value' in first && first.value.addresses.length > 0) {
      return { addresses: first.value.addresses, more: six.then((result) => ('value' in result ? result.value.addresses : [])) }
    }
    const second = await six
    const addresses = [first, second].flatMap((result) => ('value' in result ? result.value.addresses : []))
    if (addresses.length === 0) throw refusalFor([first, second])
    return { addresses }
  }

  return {
    async lookup (host, via) {
      const name = normalise(host)
      // A routed or onion name reaches nothing: not a lookup, not the proxy, not a DNS provider.
      if (name === '' || BUILTIN_ADDRESSES.namesServedHost(name) || isOnionHost(name)) throw new LookupRefusal('refused')
      if (isIP(name) !== 0) return { addresses: [name] }
      const slot = await slotFor(via)
      const own = await ownMappings(slot.session, name)
      if (own.length > 0) return { addresses: own }
      return await overDoh(slot, name, via)
    },
    drop (host, via) {
      try {
        cache.drop({ name: normalise(host), provider: providerFor(options.secureDns()), via: entryText(via) })
      } catch {
        // An entry that was never looked up through is not in the cache.
      }
    },
    clear: () => { cache.clear() },
    async close () {
      cache.clear()
      const open = [...slots.values()]
      slots.clear()
      await Promise.allSettled(open.map(async (slot) => { await slot.session.closeAllConnections() }))
    }
  }
}
