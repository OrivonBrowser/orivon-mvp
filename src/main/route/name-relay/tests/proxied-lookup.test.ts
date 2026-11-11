// The lookup of a site's address through the proxy that will carry the connection, against sessions that act as Chromium's do.

import * as dns from '@dnsquery/dns-packet'
import { describe, expect, it, vi } from 'vitest'
import { hasOwnProxy } from '../../own-proxy.js'
import { LookupRefusal, createProxiedLookup, providerFor } from '../proxied-lookup.js'
import type { LookupAnswer, LookupSession, LookupWord, ProxiedLookupOptions, ProxyEntry } from '../proxied-lookup.js'
import type { SecureDnsValue } from '../../../privacy/secure-dns.js'

const http: ProxyEntry = { scheme: 'http', host: 'proxy.test', port: 8080 }
const socks5: ProxyEntry = { scheme: 'socks5', host: 'proxy.test', port: 1080 }
const socks4: ProxyEntry = { scheme: 'socks4', host: 'proxy.test', port: 1081 }

interface Names { a?: string[], aaaa?: string[], ttl?: number, rcode?: number }
interface Sent { readonly partition: string, readonly url: string, readonly init: RequestInit, readonly rules: string | undefined, readonly question: { name: string, type: string } }

/** A DNS server's answer to the one question in `body`. */
function answerFor (zone: Readonly<Record<string, Names>>, body: Uint8Array): Uint8Array<ArrayBuffer> {
  const question = dns.decode(body).questions?.[0] as { name: string, type: string }
  const names = zone[question.name]
  const records = (question.type === 'A' ? names?.a : names?.aaaa) ?? []
  const soa = { type: 'SOA', name: 'test', ttl: 30, data: { mname: 'ns.test', rname: 'admin.test', serial: 1, refresh: 1, retry: 1, expire: 1, minimum: 30 } }
  return new Uint8Array(dns.encode({
    type: 'response',
    id: 0,
    flags: dns.RECURSION_DESIRED | dns.RECURSION_AVAILABLE | (names === undefined ? 3 : (names.rcode ?? 0)),
    questions: [question as dns.Question],
    answers: records.map((data) => ({ type: question.type as 'A', name: question.name, ttl: names?.ttl ?? 60, data })),
    authorities: records.length === 0 ? [soa as dns.Answer] : []
  }))
}

/** What a request to the DNS server comes to in a test: a reply, a status, or a failure. */
type Behaviour = (sent: Sent) => Response | Error | Promise<Response | Error>

function world (zone: Readonly<Record<string, Names>>, overrides: { behave?: Behaviour, hostRules?: Record<string, string[] | 'not-found'> } = {}) {
  const sent: Sent[] = []
  const made: string[] = []
  const proxies = new Map<string, string | undefined>()
  const calls = { userAgent: [] as Array<[string, string | undefined]>, closed: [] as string[], resolved: [] as Array<{ name: string, options: unknown }>, spelling: [] as string[] }
  const state = { behave: overrides.behave, setProxyFails: false }

  function makeSession (partition: string): LookupSession {
    made.push(partition)
    return {
      setUserAgent: (userAgent: string, languages?: string) => { calls.userAgent.push([userAgent, languages]) },
      setSpellCheckerEnabled: (enabled: boolean) => { calls.spelling.push(`${partition} enabled ${String(enabled)}`) },
      setSpellCheckerLanguages: (languages: string[]) => { calls.spelling.push(`${partition} languages ${languages.join(',')}`) },
      setProxy: async (config: { mode?: string, proxyRules?: string, proxyBypassRules?: string }) => {
        if (state.setProxyFails) throw new Error('could not set')
        expect(config.mode).toBe('fixed_servers')
        expect(config.proxyBypassRules).toBe('')
        proxies.set(partition, config.proxyRules)
      },
      closeAllConnections: async () => { calls.closed.push(partition) },
      resolveHost: async (name: string, options?: unknown) => {
        calls.resolved.push({ name, options })
        const rule = overrides.hostRules?.[name]
        if (rule === 'not-found') throw new Error('net::ERR_NAME_NOT_RESOLVED')
        if (rule === undefined) throw new Error('net::ERR_DNS_CACHE_MISS')
        return { endpoints: rule.map((address) => ({ address, family: address.includes(':') ? 'ipv6' as const : 'ipv4' as const })) }
      },
      fetch: async (url: string | Request, init?: RequestInit) => {
        const body = init?.body as Uint8Array
        const request: Sent = { partition, url: String(url), init: init ?? {}, rules: proxies.get(partition), question: dns.decode(body).questions?.[0] as { name: string, type: string } }
        sent.push(request)
        const behaviour = await (state.behave ?? ((): Response => new Response(answerFor(zone, body), { status: 200 })))(request)
        if (behaviour instanceof Error) throw behaviour
        return behaviour
      }
    } as unknown as LookupSession
  }
  return { sent, made, proxies, calls, state, makeSession }
}

function lookupWith (zone: Readonly<Record<string, Names>>, extra: Partial<ProxiedLookupOptions> = {}, overrides: Parameters<typeof world>[1] = {}) {
  const fake = world(zone, overrides)
  let setting: SecureDnsValue = 'quad9Fallback'
  const lookup = createProxiedLookup({ makeSession: fake.makeSession, secureDns: () => setting, dohUrl: () => undefined, ...extra })
  return { ...fake, ...lookup, use: (value: SecureDnsValue) => { setting = value } }
}

const refusalWord = async (work: Promise<LookupAnswer>): Promise<LookupWord | undefined> => {
  try {
    await work
    return undefined
  } catch (error) {
    return error instanceof LookupRefusal ? error.word : undefined
  }
}

const SITE = { 'site.test': { a: ['192.0.2.1', '192.0.2.2'], aaaa: ['2001:db8::1'] } }

describe('what is looked up, and in which order', () => {
  it('refuses a routed name and an onion name before any session, any resolver or any request', async () => {
    const { lookup, made, sent, calls } = lookupWith(SITE)
    for (const name of ['site.eth', 'Site.ETH.', 'x.ipfs.orivon', 'hidden.onion', 'hidden.onion.']) {
      expect(await refusalWord(lookup(name, http))).toBe('refused')
    }
    expect(made).toEqual([])
    expect(sent).toEqual([])
    expect(calls.resolved).toEqual([])
  })

  it('answers an IP literal as it is, with no session and no request', async () => {
    const { lookup, made, sent } = lookupWith(SITE)
    expect(await lookup('203.0.113.7', http)).toEqual({ addresses: ['203.0.113.7'] })
    expect(await lookup('[2001:db8::7]', http)).toEqual({ addresses: ['2001:db8::7'] })
    expect(made).toEqual([])
    expect(sent).toEqual([])
  })

  it('answers from this computer\'s own mappings, IPv4 first, with no request to a DNS server', async () => {
    const { lookup, sent, calls } = lookupWith(SITE, {}, { hostRules: { 'mapped.test': ['2001:db8::5', '127.0.0.5'] } })
    expect(await lookup('mapped.test', http)).toEqual({ addresses: ['127.0.0.5', '2001:db8::5'] })
    expect(calls.resolved).toEqual([{ name: 'mapped.test', options: { source: 'localOnly', cacheUsage: 'disallowed' } }])
    expect(sent).toEqual([])
  })

  it('refuses a name its own mappings send nowhere, with no request', async () => {
    const { lookup, sent } = lookupWith(SITE, {}, { hostRules: { 'blocked.test': 'not-found' } })
    expect(await refusalWord(lookup('blocked.test', http))).toBe('not-found')
    expect(sent).toEqual([])
  })

  it('asks a DNS server only for a name its own mappings do not know', async () => {
    const { lookup, sent, calls } = lookupWith(SITE)
    expect(await lookup('site.test', http)).toMatchObject({ addresses: ['192.0.2.1', '192.0.2.2'] })
    expect(calls.resolved).toHaveLength(1)
    expect(sent.length).toBeGreaterThan(0)
  })
})

describe('the request to the DNS server', () => {
  it('is a POST of one question with no cookie and no cache, sent from a session set to the one proxy with no bypass', async () => {
    const { lookup, sent, calls, made, proxies } = lookupWith(SITE)
    await lookup('Site.Test.', http)
    expect(made).toEqual(['orivon-name-lookup-1'])
    expect(proxies.get('orivon-name-lookup-1')).toBe('http://proxy.test:8080')
    expect(calls.userAgent).toEqual([['Mozilla/5.0', 'en-US,en']])
    expect(sent.map((request) => request.question)).toEqual([{ name: 'site.test', type: 'A', class: 'IN' }, { name: 'site.test', type: 'AAAA', class: 'IN' }])
    for (const request of sent) {
      expect(request.url).toBe('https://dns.quad9.net/dns-query')
      expect(request.rules).toBe('http://proxy.test:8080')
      expect(request.init).toMatchObject({ method: 'POST', cache: 'no-store', credentials: 'omit', headers: { 'content-type': 'application/dns-message', accept: 'application/dns-message' } })
      expect(dns.decode(request.init.body as Uint8Array).id).toBe(0)
    }
  })

  it('goes through the entry\'s scheme, an IPv6 proxy in brackets', async () => {
    const { lookup, proxies, made } = lookupWith(SITE)
    await lookup('site.test', { scheme: 'https', host: 'secure.proxy.test', port: 8443 })
    await lookup('site.test', socks5)
    await lookup('site.test', socks4)
    await lookup('site.test', { scheme: 'http', host: '::1', port: 3128 })
    expect(made).toHaveLength(4)
    expect([...proxies.values()]).toEqual(['https://secure.proxy.test:8443', 'socks5://proxy.test:1080', 'socks4://proxy.test:1081', 'http://[::1]:3128'])
  })

  it('names the server by name through HTTP, HTTPS and SOCKS5, and by address through SOCKS4', async () => {
    const { lookup, sent, use } = lookupWith(SITE)
    await lookup('site.test', http)
    await lookup('site.test', socks5)
    await lookup('site.test', socks4)
    expect(new Set(sent.filter((request) => request.rules?.startsWith('socks4:') !== true).map((request) => request.url))).toEqual(new Set(['https://dns.quad9.net/dns-query']))
    expect(new Set(sent.filter((request) => request.rules?.startsWith('socks4:') === true).map((request) => request.url))).toEqual(new Set(['https://9.9.9.9/dns-query']))
    use('cloudflare')
    await lookup('other.test', socks4).catch(() => {})
    expect(sent.at(-1)?.url).toBe('https://1.1.1.1/dns-query')
  })

  it('goes to the provider the Secure DNS setting names, Quad9 when it names none, and never to a second one when that fails', async () => {
    const expected: Record<SecureDnsValue, string> = {
      quad9Fallback: 'https://dns.quad9.net/dns-query',
      quad9: 'https://dns.quad9.net/dns-query',
      cloudflare: 'https://cloudflare-dns.com/dns-query',
      automatic: 'https://dns.quad9.net/dns-query',
      off: 'https://dns.quad9.net/dns-query'
    }
    for (const [value, url] of Object.entries(expected) as Array<[SecureDnsValue, string]>) {
      expect(providerFor(value)).toBe(url.includes('cloudflare') ? 'cloudflare' : 'quad9')
      const { lookup, sent, use } = lookupWith(SITE, {}, { behave: () => new Response('', { status: 503 }) })
      use(value)
      expect(await refusalWord(lookup('site.test', http))).toBe('no-answer')
      expect(new Set(sent.map((request) => request.url))).toEqual(new Set([url]))
    }
  })

  it('goes to the address a test names in place of the provider\'s', async () => {
    const { lookup, sent } = lookupWith(SITE, { dohUrl: () => 'https://fake-doh.test/dns-query' })
    await lookup('site.test', socks4)
    expect(new Set(sent.map((request) => request.url))).toEqual(new Set(['https://fake-doh.test/dns-query']))
  })

  it('follows the Secure DNS setting at each lookup', async () => {
    const { lookup, sent, use } = lookupWith({ ...SITE, 'other.test': { a: ['192.0.2.9'] } })
    await lookup('site.test', http)
    use('cloudflare')
    await lookup('other.test', http)
    expect(sent.at(-1)?.url).toBe('https://cloudflare-dns.com/dns-query')
  })
})

describe('the answer', () => {
  it('gives IPv4 first and keeps IPv6 for later without waiting for it', async () => {
    let releaseSix: (() => void) | undefined
    const behave: Behaviour = async (request) => {
      if (request.question.type === 'AAAA') await new Promise<void>((resolve) => { releaseSix = resolve })
      return new Response(answerFor(SITE, request.init.body as Uint8Array), { status: 200 })
    }
    const { lookup } = lookupWith(SITE, {}, { behave })
    const answer = await lookup('site.test', http)
    expect(answer.addresses).toEqual(['192.0.2.1', '192.0.2.2'])
    await vi.waitFor(() => { expect(releaseSix).toBeDefined() })
    releaseSix?.()
    expect(await answer.more).toEqual(['2001:db8::1'])
  })

  it('waits for IPv6 when IPv4 names no address', async () => {
    const { lookup } = lookupWith({ 'v6.test': { aaaa: ['2001:db8::2'] } })
    expect(await lookup('v6.test', http)).toEqual({ addresses: ['2001:db8::2'] })
  })

  it('refuses a name the server does not know, and a name with no address of either family', async () => {
    const { lookup } = lookupWith({ 'empty.test': {} })
    expect(await refusalWord(lookup('nowhere.test', http))).toBe('not-found')
    expect(await refusalWord(lookup('empty.test', http))).toBe('not-found')
  })

  it('uses the family that answered when the other failed, and refuses when neither did', async () => {
    const behave: Behaviour = (request) => request.question.type === 'AAAA' ? new Response('', { status: 500 }) : new Response(answerFor(SITE, request.init.body as Uint8Array), { status: 200 })
    expect((await lookupWith(SITE, {}, { behave }).lookup('site.test', http)).addresses).toEqual(['192.0.2.1', '192.0.2.2'])
    const half: Behaviour = (request) => request.question.type === 'A' ? new Response(answerFor({}, request.init.body as Uint8Array), { status: 200 }) : new Response('', { status: 500 })
    expect(await refusalWord(lookupWith(SITE, {}, { behave: half }).lookup('site.test', http))).toBe('not-found')
  })
})

describe('every refusal has one word', () => {
  const words: Array<[string, Behaviour, LookupWord]> = [
    ['another HTTP status', () => new Response('', { status: 500 }), 'no-answer'],
    ['another HTTP status, whatever its body holds', (sent) => new Response(answerFor(SITE, sent.init.body as Uint8Array), { status: 502 }), 'no-answer'],
    ['a 407 from the server itself', () => new Response('', { status: 407 }), 'sign-in'],
    ['SERVFAIL', (sent) => new Response(answerFor({ [sent.question.name]: { rcode: 2 } }, sent.init.body as Uint8Array), { status: 200 }), 'no-answer'],
    ['bytes that do not decode', () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }), 'no-answer'],
    ['a proxy that refuses the tunnel', () => new Error('net::ERR_TUNNEL_CONNECTION_FAILED'), 'unreachable'],
    ['a proxy that cannot be reached', () => new Error('net::ERR_PROXY_CONNECTION_FAILED'), 'unreachable'],
    ['a SOCKS proxy that fails', () => new Error('net::ERR_SOCKS_CONNECTION_FAILED'), 'unreachable'],
    ['a connection refused', () => new Error('net::ERR_CONNECTION_REFUSED'), 'unreachable'],
    ['a proxy that asks for a sign-in', () => new Error('net::ERR_PROXY_AUTH_REQUESTED'), 'sign-in'],
    ['a proxy sign-in no scheme of Chromium\'s can answer', () => new Error('net::ERR_PROXY_AUTH_UNSUPPORTED'), 'sign-in'],
    ['a certificate the server could not prove', () => new Error('net::ERR_CERT_AUTHORITY_INVALID'), 'no-answer']
  ]
  it.each(words)('%s', async (_what, behave, word) => {
    const { lookup } = lookupWith(SITE, {}, { behave })
    expect(await refusalWord(lookup('site.test', http))).toBe(word)
  })

  it('gives up on a query after the time allowed, as no answer', async () => {
    const behave: Behaviour = async (sent) => await new Promise<never>((_resolve, reject) => { (sent.init.signal as AbortSignal).addEventListener('abort', () => { reject(new Error('This operation was aborted')) }) })
    const { lookup } = lookupWith(SITE, { queryTimeoutMs: 20 }, { behave })
    expect(await refusalWord(lookup('site.test', http))).toBe('no-answer')
  })

  it('carries nothing but the word: no name, no address, no proxy', async () => {
    const { lookup } = lookupWith(SITE, {}, { behave: () => new Error('net::ERR_TUNNEL_CONNECTION_FAILED proxy.test:8080 for site.test') })
    const error = await lookup('site.test', http).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LookupRefusal)
    expect(JSON.stringify([(error as Error).message, (error as Error).stack?.split('\n')[0], (error as LookupRefusal).word])).toBe('["unreachable","LookupRefusal: unreachable","unreachable"]')
  })
})

describe('a network change', () => {
  it('is answered by one more try, and only one', async () => {
    let tries = 0
    const behave: Behaviour = (sent) => ++tries === 1 ? new Error('net::ERR_NETWORK_CHANGED') : new Response(answerFor(SITE, sent.init.body as Uint8Array), { status: 200 })
    const { lookup, sent } = lookupWith(SITE, {}, { behave })
    expect((await lookup('site.test', http)).addresses).toEqual(['192.0.2.1', '192.0.2.2'])
    expect(sent.filter((request) => request.question.type === 'A')).toHaveLength(2)

    const always = lookupWith(SITE, {}, { behave: () => new Error('net::ERR_NETWORK_CHANGED') })
    expect(await refusalWord(always.lookup('site.test', http))).toBe('no-answer')
    expect(always.sent.filter((request) => request.question.type === 'A')).toHaveLength(2)
  })

  it('makes the lookup forget every answer it kept, since they were found on the network that is gone', async () => {
    const zone = { ...SITE, 'other.test': { a: ['192.0.2.9'] } }
    let changed = false
    const behave: Behaviour = (sent) => {
      if (changed && sent.question.name === 'other.test') { changed = false; return new Error('net::ERR_NETWORK_CHANGED') }
      return new Response(answerFor(zone, sent.init.body as Uint8Array), { status: 200 })
    }
    const { lookup, sent } = lookupWith(zone, {}, { behave })
    await lookup('site.test', http)
    const kept = sent.length
    await lookup('site.test', http)
    expect(sent, 'served from memory').toHaveLength(kept)

    changed = true
    await lookup('other.test', http)
    const before = sent.length
    await lookup('site.test', http)
    expect(sent.length, 'asked again').toBeGreaterThan(before)
  })

  it('does not try again after another failure', async () => {
    const { lookup, sent } = lookupWith(SITE, {}, { behave: () => new Error('net::ERR_TUNNEL_CONNECTION_FAILED') })
    await refusalWord(lookup('site.test', http))
    expect(sent.filter((request) => request.question.type === 'A')).toHaveLength(1)
  })
})

describe('what is remembered', () => {
  it('serves a name again from memory, and asks again through another proxy entry', async () => {
    const { lookup, sent } = lookupWith(SITE)
    await lookup('site.test', http)
    const first = sent.length
    await lookup('site.test', http)
    expect(sent).toHaveLength(first)
    await lookup('site.test', socks5)
    expect(sent.length).toBeGreaterThan(first)
  })

  it('shares the queries of lookups that overlap', async () => {
    const { lookup, sent } = lookupWith(SITE)
    await Promise.all([lookup('site.test', http), lookup('site.test', http), lookup('site.test', http)])
    expect(sent).toHaveLength(2)
  })

  it('forgets a name when asked to, or everything', async () => {
    const { lookup, drop, clear, sent } = lookupWith({ ...SITE, 'other.test': { a: ['192.0.2.9'] } })
    await lookup('site.test', http)
    await lookup('other.test', http)
    const count = sent.length
    drop('site.test', http)
    await lookup('other.test', http)
    expect(sent).toHaveLength(count)
    await lookup('site.test', http)
    expect(sent.length).toBeGreaterThan(count)
    const after = sent.length
    clear()
    await lookup('other.test', http)
    expect(sent.length).toBeGreaterThan(after)
  })
})

describe('the lookup sessions', () => {
  it('are in memory, named by number, marked as setting a proxy of their own, and shared by lookups through one entry', async () => {
    const fake = world(SITE)
    let made: LookupSession | undefined
    const lookup = createProxiedLookup({ makeSession: (partition) => (made ??= fake.makeSession(partition)), secureDns: () => 'quad9', dohUrl: () => undefined })
    await lookup.lookup('site.test', http)
    await lookup.lookup('other.test', http).catch(() => {})
    expect(made).toBeDefined()
    expect(hasOwnProxy(made as object)).toBe(true)
    expect(fake.made).toEqual(['orivon-name-lookup-1'])
    expect(fake.proxies.size).toBe(1)
  })

  it('have no spell checker, which would fetch a dictionary into them through the proxy', async () => {
    const fake = world(SITE)
    const lookup = createProxiedLookup({ makeSession: fake.makeSession, secureDns: () => 'quad9', dohUrl: () => undefined })
    await lookup.lookup('site.test', http)
    expect(fake.calls.spelling).toEqual(['orivon-name-lookup-1 enabled false', 'orivon-name-lookup-1 languages '])
  })

  it('are four at most: a fifth entry takes the one used longest ago, closing its connections', async () => {
    const { lookup, made, proxies, calls } = lookupWith(SITE)
    const entry = (port: number): ProxyEntry => ({ scheme: 'http', host: 'proxy.test', port })
    for (const port of [1, 2, 3, 4]) await lookup('site.test', entry(port))
    await lookup('site.test', entry(1))
    await lookup('site.test', entry(5))
    expect(made).toEqual(['orivon-name-lookup-1', 'orivon-name-lookup-2', 'orivon-name-lookup-3', 'orivon-name-lookup-4'])
    expect(calls.closed).toEqual(['orivon-name-lookup-2'])
    expect(proxies.get('orivon-name-lookup-2')).toBe('http://proxy.test:5')
    expect(proxies.get('orivon-name-lookup-1')).toBe('http://proxy.test:1')
  })

  it('send the first query alone, and the rest once it has ended', async () => {
    const releases: Array<() => void> = []
    const behave: Behaviour = async (sent) => {
      await new Promise<void>((resolve) => releases.push(resolve))
      return new Response(answerFor(SITE, sent.init.body as Uint8Array), { status: 200 })
    }
    const { lookup, sent } = lookupWith(SITE, {}, { behave })
    const pending = Promise.all([lookup('site.test', http), lookup('other.test', http).catch(() => undefined)])
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sent).toHaveLength(1)
    releases[0]?.()
    await vi.waitFor(() => { expect(sent).toHaveLength(4) })
    releases.forEach((release) => { release() })
    await pending
  })

  it('fail the queries that waited when the first could not reach the proxy, without sending them', async () => {
    const { lookup, sent } = lookupWith(SITE, {}, { behave: () => new Error('net::ERR_PROXY_CONNECTION_FAILED') })
    expect(await refusalWord(lookup('site.test', http))).toBe('unreachable')
    expect(sent).toHaveLength(1)
  })

  it('are set up again for the next lookup when setting the proxy failed', async () => {
    const fake = lookupWith(SITE)
    fake.state.setProxyFails = true
    expect(await refusalWord(fake.lookup('site.test', http))).toBe('unreachable')
    fake.state.setProxyFails = false
    expect((await fake.lookup('site.test', http)).addresses).toEqual(['192.0.2.1', '192.0.2.2'])
  })

  it('close with the lookup, and the next entry takes a session again by the same name', async () => {
    const { lookup, close, calls, made, proxies } = lookupWith(SITE)
    await lookup('site.test', http)
    await close()
    expect(calls.closed).toEqual(['orivon-name-lookup-1'])
    await lookup('site.test', socks5)
    expect(made).toEqual(['orivon-name-lookup-1'])
    expect(proxies.get('orivon-name-lookup-1')).toBe('socks5://proxy.test:1080')
  })
})

describe('an entry that cannot be a proxy', () => {
  it('is refused before any session is set, whatever rule it could add', async () => {
    const { lookup, made, proxies } = lookupWith(SITE)
    for (const entry of [
      { scheme: 'http', host: 'proxy.test;direct://', port: 80 },
      { scheme: 'http', host: 'a b', port: 80 },
      { scheme: 'http', host: 'proxy.test,socks5://other', port: 80 },
      { scheme: 'http', host: '', port: 80 },
      { scheme: 'http', host: 'proxy.test', port: 0 },
      { scheme: 'http', host: 'proxy.test', port: 70000 },
      { scheme: 'direct', host: 'proxy.test', port: 80 }
    ] as unknown as ProxyEntry[]) {
      expect(await refusalWord(lookup('site.test', entry))).toBe('unreachable')
    }
    expect(made).toEqual([])
    expect(proxies.size).toBe(0)
  })
})
