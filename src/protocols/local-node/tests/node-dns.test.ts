import { describe, expect, it } from 'vitest'
import type { LookupAddress } from '../../../contracts/index.js'
import type { Dial } from '../../../broker/broker-contracts.js'
import { DOH_PAUSE_MS, MAX_CACHED_NAMES, MAX_TTL_SECONDS, MIN_TTL_SECONDS, NEGATIVE_TTL_SECONDS, createNodeLookup } from '../node-dns.js'
import { createNodeNet } from '../node-net.js'

const CLOUDFLARE = 'https://cloudflare-dns.com/dns-query'
const GOOGLE = 'https://dns.google/resolve'
const ENDPOINTS = [CLOUDFLARE, GOOGLE]

type Records = Record<string, { A?: Array<[string, number]>, AAAA?: Array<[string, number]>, status?: number }>

function dnsJson (name: string, type: 'A' | 'AAAA', records: Records): Response {
  const entry = records[name]
  const code = type === 'A' ? 1 : 28
  const status = entry?.status ?? (entry === undefined ? 3 : 0)
  const answer = (entry?.[type] ?? []).map(([data, TTL]) => ({ name, type: code, TTL, data }))
  return new Response(JSON.stringify({ Status: status, ...(answer.length > 0 ? { Answer: answer } : {}) }), { headers: { 'content-type': 'application/dns-json' } })
}

interface Harness {
  readonly lookup: (hostname: string) => Promise<readonly LookupAddress[]>
  readonly requests: string[]
  readonly system: string[]
  clock: { now: number }
  readonly down: Set<string>
  /** Record types whose query fails at every endpoint. */
  readonly failing: Set<'A' | 'AAAA'>
}

function harness (records: Records, systemAnswers: Record<string, readonly string[]> = {}, endpoints: readonly string[] = ENDPOINTS): Harness {
  const requests: string[] = []
  const system: string[] = []
  const clock = { now: 1_000_000 }
  const down = new Set<string>()
  const failing = new Set<'A' | 'AAAA'>()
  const fetch = async (url: string): Promise<Response> => {
    requests.push(url)
    const parsed = new URL(url)
    if (down.has(parsed.origin)) throw new Error('connect ECONNREFUSED')
    const type = parsed.searchParams.get('type') as 'A' | 'AAAA'
    if (failing.has(type)) throw new Error('timed out')
    return dnsJson(parsed.searchParams.get('name') ?? '', type, records)
  }
  const lookup = createNodeLookup({
    endpoints,
    fetch,
    system: async (hostname) => {
      system.push(hostname)
      return (systemAnswers[hostname] ?? []).map((address) => ({ address, family: address.includes(':') ? 'IPv6' as const : 'IPv4' as const }))
    },
    now: () => clock.now
  })
  return { lookup, requests, system, clock, down, failing }
}

describe('createNodeLookup', () => {
  it('answers from DNS-over-HTTPS, asking for A and AAAA, and never the system resolver', async () => {
    const { lookup, requests, system } = harness({ 'svc.example': { A: [['104.18.1.1', 60]], AAAA: [['2606:4700::1', 60]] } }, { 'svc.example': ['85.38.30.19'] })
    expect(await lookup('svc.example')).toEqual([{ address: '104.18.1.1', family: 'IPv4' }, { address: '2606:4700::1', family: 'IPv6' }])
    expect(system).toEqual([])
    expect(requests.map((url) => new URL(url).searchParams.get('type')).sort()).toEqual(['A', 'AAAA'])
  })

  it('answers with the IPv6 addresses alone when a name has no A record', async () => {
    const { lookup } = harness({ 'six.example': { AAAA: [['2606:4700::2', 30]] } })
    expect(await lookup('six.example')).toEqual([{ address: '2606:4700::2', family: 'IPv6' }])
  })

  it('asks the next endpoint when the first cannot answer', async () => {
    const { lookup, requests, system, down } = harness({ 'svc.example': { A: [['104.18.1.1', 60]] } })
    down.add('https://cloudflare-dns.com')
    expect(await lookup('svc.example')).toEqual([{ address: '104.18.1.1', family: 'IPv4' }])
    expect(system).toEqual([])
    expect(requests.some((url) => url.startsWith(GOOGLE))).toBe(true)
  })

  it('treats NXDOMAIN as the answer, not as a failure', async () => {
    const { lookup, system } = harness({}, { 'gone.example': ['85.38.30.19'] })
    expect(await lookup('gone.example')).toEqual([])
    expect(system).toEqual([])
  })

  it('falls back to the system resolver when A fails everywhere and AAAA says the name has none', async () => {
    const { lookup, system, failing } = harness({ 'v4.example': { A: [['104.18.1.1', 60]] } }, { 'v4.example': ['9.9.9.9'] })
    failing.add('A')
    expect(await lookup('v4.example')).toEqual([{ address: '9.9.9.9', family: 'IPv4' }])
    expect(system).toEqual(['v4.example'])
  })

  it('never keeps a failure: once DoH is asked again the real answer is used', async () => {
    const { lookup, system, failing, clock } = harness({ 'v4.example': { A: [['104.18.1.1', 60]] } }, { 'v4.example': ['9.9.9.9'] })
    failing.add('A')
    await lookup('v4.example')
    failing.clear()
    clock.now += DOH_PAUSE_MS + 1
    expect(await lookup('v4.example')).toEqual([{ address: '104.18.1.1', family: 'IPv4' }])
    expect(system).toEqual(['v4.example'])
  })

  it('uses what one family answered while the other failed, and keeps none of it', async () => {
    const { lookup, requests, failing } = harness({ 'dual.example': { A: [['104.18.1.1', 60]], AAAA: [['2606:4700::1', 60]] } })
    failing.add('A')
    expect(await lookup('dual.example')).toEqual([{ address: '2606:4700::1', family: 'IPv6' }])
    failing.clear()
    const before = requests.length
    expect(await lookup('dual.example')).toEqual([{ address: '104.18.1.1', family: 'IPv4' }, { address: '2606:4700::1', family: 'IPv6' }])
    expect(requests.length).toBeGreaterThan(before)
  })

  it('remembers a name both families answered with no records for a short while only', async () => {
    const { lookup, requests, system, clock } = harness({ 'none.example': { status: 0 } }, { 'none.example': ['9.9.9.9'] })
    expect(await lookup('none.example')).toEqual([])
    const first = requests.length
    clock.now += 1000 * (NEGATIVE_TTL_SECONDS - 1)
    expect(await lookup('none.example')).toEqual([])
    expect(requests).toHaveLength(first)
    clock.now += 2000
    expect(await lookup('none.example')).toEqual([])
    expect(requests.length).toBeGreaterThan(first)
    expect(system).toEqual([])
  })

  it('remembers NXDOMAIN for a short while only, and does not ask the system resolver', async () => {
    const { lookup, requests, system, clock } = harness({}, { 'gone.example': ['9.9.9.9'] })
    expect(await lookup('gone.example')).toEqual([])
    const first = requests.length
    clock.now += 1000 * (NEGATIVE_TTL_SECONDS - 1)
    await lookup('gone.example')
    expect(requests).toHaveLength(first)
    clock.now += 2000
    await lookup('gone.example')
    expect(requests.length).toBeGreaterThan(first)
    expect(system).toEqual([])
  })

  it('falls back to the system resolver when every endpoint fails, and then leaves DoH alone for a while', async () => {
    const { lookup, requests, system, down, clock } = harness({ 'a.example': { A: [['104.18.1.1', 60]] }, 'b.example': { A: [['104.18.1.2', 60]] } }, { 'a.example': ['9.9.9.9'], 'b.example': ['9.9.9.10'] })
    down.add('https://cloudflare-dns.com')
    down.add('https://dns.google')
    expect(await lookup('a.example')).toEqual([{ address: '9.9.9.9', family: 'IPv4' }])
    const spent = requests.length
    expect(await lookup('b.example')).toEqual([{ address: '9.9.9.10', family: 'IPv4' }])
    expect(requests).toHaveLength(spent)
    down.clear()
    clock.now += DOH_PAUSE_MS + 1
    expect(await lookup('b.example')).toEqual([{ address: '104.18.1.2', family: 'IPv4' }])
    expect(system).toEqual(['a.example', 'b.example'])
  })

  it('falls back when a provider answers with garbage or an error status', async () => {
    const { lookup, system } = harness({ 'bad.example': { status: 2 } }, { 'bad.example': ['9.9.9.9'] })
    expect(await lookup('bad.example')).toEqual([{ address: '9.9.9.9', family: 'IPv4' }])
    expect(system).toEqual(['bad.example'])
  })

  it('answers a name the providers SERVFAIL on from the system resolver, and keeps asking DoH for the next name', async () => {
    const { lookup, requests, system } = harness({ 'peer.example': { status: 2 }, 'svc.example': { A: [['104.18.1.1', 60]] } }, { 'peer.example': ['9.9.9.9'] })
    expect(await lookup('peer.example')).toEqual([{ address: '9.9.9.9', family: 'IPv4' }])
    const before = requests.length
    expect(await lookup('svc.example')).toEqual([{ address: '104.18.1.1', family: 'IPv4' }])
    expect(requests.length).toBeGreaterThan(before)
    expect(system).toEqual(['peer.example'])
    await lookup('peer.example')
    expect(system).toEqual(['peer.example', 'peer.example'])
  })

  it.each([
    ['REFUSED', 5],
    ['FORMERR', 1],
    ['NOTIMP', 4]
  ])('treats %s for one name as that name failing, not the providers', async (_label, status) => {
    const { lookup, requests, system } = harness({ 'peer.example': { status }, 'svc.example': { A: [['104.18.1.1', 60]] } }, { 'peer.example': ['9.9.9.9'] })
    await lookup('peer.example')
    const before = requests.length
    await lookup('svc.example')
    expect(requests.length).toBeGreaterThan(before)
    expect(system).toEqual(['peer.example'])
  })

  it.each([
    ['a non-2xx status', async () => new Response('busy', { status: 503 })],
    ['a malformed body', async () => new Response('<html>', { status: 200 })],
    ['a timeout', async () => { throw new DOMException('timed out', 'TimeoutError') }]
  ])('pauses DoH for every name when the endpoints fail with %s', async (_label, answer) => {
    const requests: string[] = []
    const system: string[] = []
    const lookup = createNodeLookup({
      endpoints: ENDPOINTS,
      fetch: async (url) => { requests.push(url); return await answer() },
      system: async (hostname) => { system.push(hostname); return [{ address: '9.9.9.9', family: 'IPv4' }] }
    })
    await lookup('a.example')
    const spent = requests.length
    await lookup('b.example')
    expect(requests).toHaveLength(spent)
    expect(system).toEqual(['a.example', 'b.example'])
  })

  it('keeps an answer for its TTL, clamped, and asks again after', async () => {
    const { lookup, requests, clock } = harness({ 'short.example': { A: [['104.18.1.1', 1]] }, 'long.example': { A: [['104.18.1.2', 86_400]] } })
    await lookup('short.example')
    await lookup('long.example')
    const first = requests.length
    clock.now += 1000 * (MIN_TTL_SECONDS - 1)
    await lookup('short.example')
    expect(requests).toHaveLength(first)
    clock.now += 2000
    await lookup('short.example')
    expect(requests.length).toBeGreaterThan(first)
    const second = requests.length
    clock.now += 1000 * (MAX_TTL_SECONDS - MIN_TTL_SECONDS)
    await lookup('long.example')
    expect(requests.length).toBeGreaterThan(second)
  })

  it('shares one query between concurrent lookups of a name, whatever its case', async () => {
    const { lookup, requests } = harness({ 'svc.example': { A: [['104.18.1.1', 60]] } })
    await Promise.all([lookup('svc.example'), lookup('SVC.example'), lookup('svc.example')])
    expect(requests).toHaveLength(2)
  })

  it('remembers a bounded number of names', async () => {
    const records: Records = {}
    for (let i = 0; i <= MAX_CACHED_NAMES; i += 1) records[`n${String(i)}.example`] = { A: [['104.18.1.1', 300]] }
    const { lookup, requests } = harness(records)
    for (let i = 0; i <= MAX_CACHED_NAMES; i += 1) await lookup(`n${String(i)}.example`)
    const before = requests.length
    await lookup('n0.example')
    expect(requests.length).toBeGreaterThan(before)
  })

  it('reaches only the configured DNS-over-HTTPS origins', async () => {
    const { lookup, requests } = harness({ 'svc.example': { A: [['104.18.1.1', 60]] } })
    await lookup('svc.example')
    expect(new Set(requests.map((url) => new URL(url).origin))).toEqual(new Set(['https://cloudflare-dns.com']))
  })

  it('does not follow a redirect to another origin', async () => {
    const requests: string[] = []
    const lookup = createNodeLookup({
      endpoints: [CLOUDFLARE],
      fetch: async (url) => {
        requests.push(url)
        return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/dns' } })
      },
      system: async () => [{ address: '9.9.9.9', family: 'IPv4' }]
    })
    expect(await lookup('svc.example')).toEqual([{ address: '9.9.9.9', family: 'IPv4' }])
    expect(requests.every((url) => url.startsWith(CLOUDFLARE))).toBe(true)
  })

  it('is the system resolver itself when no endpoint is configured', async () => {
    const system = async (): Promise<readonly LookupAddress[]> => []
    expect(createNodeLookup({ endpoints: [], fetch: async () => { throw new Error('never') }, system })).toBe(system)
  })
})

describe('a node dialling through the DoH lookup', () => {
  function connect (records: Records, systemAnswers: Record<string, readonly string[]> = {}) {
    const { lookup } = harness(records, systemAnswers)
    const dials: Array<readonly string[]> = []
    const dial: Dial = async (addresses) => { dials.push(addresses); throw new Error('stop after the policy') }
    const net = createNodeNet(1, { dial, listen: async () => { throw new Error('unused') }, bind: async () => { throw new Error('unused') }, lookup })
    return { net, dials }
  }

  it('dials the DoH answer, not the address a hijacking resolver gives', async () => {
    const { net, dials } = connect({ 'svc.example': { A: [['104.18.1.1', 60]] } }, { 'svc.example': ['85.38.30.19'] })
    await expect(net.connect({ host: 'svc.example', port: 443 })).rejects.toThrow('stop after the policy')
    expect(dials).toEqual([['104.18.1.1']])
  })

  it('dials an IPv6 answer as its canonical literal', async () => {
    const { net, dials } = connect({ 'six.example': { AAAA: [['2606:4700:0:0:0:0:0:1', 60]] } })
    await expect(net.connect({ host: 'six.example', port: 443 })).rejects.toThrow('stop after the policy')
    expect(dials).toEqual([['2606:4700::1']])
  })

  it.each([
    ['a loopback answer', [['127.0.0.1', 60], ['104.18.1.1', 60]]],
    ['a private answer', [['10.0.0.5', 60]]],
    ['a link-local answer', [['169.254.169.254', 60]]],
    ['text that is no address', [['not-an-address', 60], ['104.18.1.1', 60]]]
  ] as const)('refuses the whole name for %s', async (_label, answers) => {
    const { net, dials } = connect({ 'evil.example': { A: answers.map(([data, ttl]) => [data, ttl]) } })
    await expect(net.connect({ host: 'evil.example', port: 443 })).rejects.toMatchObject({ code: 'denied' })
    expect(dials).toEqual([])
  })

  it('refuses a non-public IPv6 answer', async () => {
    const { net, dials } = connect({ 'evil.example': { AAAA: [['::1', 60]], A: [['104.18.1.1', 60]] } })
    await expect(net.connect({ host: 'evil.example', port: 443 })).rejects.toMatchObject({ code: 'denied' })
    expect(dials).toEqual([])
  })

  it('still refuses a non-public answer of the system resolver when DoH is down', async () => {
    const { lookup, down } = harness({}, { 'evil.example': ['192.168.1.1'] })
    down.add('https://cloudflare-dns.com')
    down.add('https://dns.google')
    const net = createNodeNet(1, { dial: async () => { throw new Error('never dialled') }, listen: async () => { throw new Error('unused') }, bind: async () => { throw new Error('unused') }, lookup })
    await expect(net.connect({ host: 'evil.example', port: 443 })).rejects.toMatchObject({ code: 'denied' })
  })

  it('reports a name nothing resolves as unreachable', async () => {
    const { net } = connect({})
    await expect(net.connect({ host: 'gone.example', port: 443 })).rejects.toMatchObject({ code: 'unreachable' })
  })
})

describe('a node with no system resolver (it runs through a tunnel)', () => {
  const answering = (down: boolean): ReturnType<typeof createNodeLookup> => createNodeLookup({
    endpoints: [CLOUDFLARE],
    fetch: async (url) => {
      if (down) throw new Error('connect ECONNREFUSED')
      const parsed = new URL(url)
      return dnsJson(parsed.searchParams.get('name') ?? '', parsed.searchParams.get('type') as 'A' | 'AAAA', { 'peer.test': { A: [['93.184.216.34', 60]] } })
    }
  })

  it('resolves from the endpoints, and stays unresolved when none answers, with no pause that would send the next name anywhere else', async () => {
    expect((await answering(false)('peer.test')).map((answer) => answer.address)).toEqual(['93.184.216.34'])
    const lookup = answering(true)
    await expect(lookup('peer.test')).rejects.toThrow(/no DNS-over-HTTPS resolver answered/)
    await expect(lookup('other.test')).rejects.toThrow(/no DNS-over-HTTPS resolver answered/)
  })

  it('cannot be made with no endpoint at all', () => {
    expect(() => createNodeLookup({ endpoints: [], fetch: async () => await Promise.reject(new Error('never')) })).toThrow(/needs DNS-over-HTTPS endpoints/)
  })
})
