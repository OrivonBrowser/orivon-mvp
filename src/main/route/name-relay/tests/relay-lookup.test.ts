// The relay's lookup for a caller that checks an address: it takes the steps and the proxy entry a relayed connection to the URL
// would, and returns every address so the caller judges all of them.

import { describe, expect, it } from 'vitest'
import { LookupRefusal } from '../proxied-lookup.js'
import type { LookupAnswer, ProxyEntry } from '../proxied-lookup.js'
import { RelayRefusal } from '../relay-failures.js'
import { createRelayLookup } from '../relay-lookup.js'

const SITE = 'shop.example'
const URL_OF_SITE = `https://${SITE}/`

type Reply = LookupAnswer | Error

function rig (options: { answer: string | Error, replies?: (via: ProxyEntry) => Reply, direct?: readonly string[] | Error }) {
  const asked: string[] = []
  const lookups: Array<{ host: string, via: string }> = []
  const directLookups: string[] = []
  const lookup = createRelayLookup({
    systemAnswer: async (url) => {
      asked.push(url)
      if (options.answer instanceof Error) throw options.answer
      return options.answer
    },
    lookup: async (host, via) => {
      lookups.push({ host, via: `${via.scheme} ${via.host}:${String(via.port)}` })
      const reply = options.replies?.(via) ?? { addresses: [] }
      if (reply instanceof Error) throw reply
      return reply
    },
    lookupDirect: async (host) => {
      directLookups.push(host)
      if (options.direct instanceof Error) throw options.direct
      return options.direct ?? []
    }
  })
  return { lookup, asked, lookups, directLookups }
}

async function refusal (attempt: Promise<unknown>): Promise<RelayRefusal> {
  const error = await attempt.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(RelayRefusal)
  return error as RelayRefusal
}

describe('a name behind a proxy', () => {
  it('is looked up through the entry the system names for the URL, and every address comes back, IPv4 first', async () => {
    const { lookup, asked, lookups } = rig({ answer: 'PROXY proxy.test:3128', replies: () => ({ addresses: ['203.0.113.7'], more: Promise.resolve(['2001:db8::7']) }) })
    expect(await lookup(SITE, URL_OF_SITE)).toEqual(['203.0.113.7', '2001:db8::7'])
    expect(asked).toEqual([URL_OF_SITE])
    expect(lookups).toEqual([{ host: SITE, via: 'http proxy.test:3128' }])
  })

  it('names each kind of proxy by its scheme', async () => {
    for (const [answer, via] of [['HTTPS p.test:443', 'https p.test:443'], ['SOCKS5 p.test:1080', 'socks5 p.test:1080'], ['SOCKS p.test:1080', 'socks4 p.test:1080']] as const) {
      const { lookup, lookups } = rig({ answer, replies: () => ({ addresses: ['203.0.113.7'] }) })
      await lookup(SITE, URL_OF_SITE)
      expect(lookups.map((seen) => seen.via)).toEqual([via])
    }
  })

  it('moves to the next proxy of a list only when the first cannot be passed through', async () => {
    const { lookup, lookups } = rig({ answer: 'PROXY a.test:1; PROXY b.test:2', replies: (via) => via.host === 'a.test' ? new LookupRefusal('unreachable') : { addresses: ['203.0.113.7'] } })
    expect(await lookup(SITE, URL_OF_SITE)).toEqual(['203.0.113.7'])
    expect(lookups.map((seen) => seen.via)).toEqual(['http a.test:1', 'http b.test:2'])
    const stops = rig({ answer: 'PROXY a.test:1; PROXY b.test:2', replies: () => new LookupRefusal('not-found') })
    expect((await refusal(stops.lookup(SITE, URL_OF_SITE))).word).toBe('not-found')
    expect(stops.lookups).toHaveLength(1)
  })

  it('refuses with the lookup\'s word, and as unreachable when every proxy of the list was', async () => {
    for (const word of ['not-found', 'no-answer', 'sign-in', 'refused'] as const) {
      expect((await refusal(rig({ answer: 'PROXY a.test:1', replies: () => new LookupRefusal(word) }).lookup(SITE, URL_OF_SITE))).word).toBe(word)
    }
    expect((await refusal(rig({ answer: 'PROXY a.test:1; PROXY b.test:2', replies: () => new LookupRefusal('unreachable') }).lookup(SITE, URL_OF_SITE))).word).toBe('unreachable')
    expect((await refusal(rig({ answer: 'PROXY a.test:1', replies: () => new Error('boom') }).lookup(SITE, URL_OF_SITE))).word).toBe('no-answer')
  })

  it('refuses a SOCKS proxy on Tor\'s usual port before any lookup', async () => {
    const { lookup, lookups } = rig({ answer: 'SOCKS5 127.0.0.1:9050' })
    expect((await refusal(lookup(SITE, URL_OF_SITE))).word).toBe('anonymity')
    expect(lookups).toEqual([])
  })

  it('never takes a direct entry after a proxy', async () => {
    const { lookup, directLookups } = rig({ answer: 'PROXY a.test:1; DIRECT', replies: () => new LookupRefusal('unreachable'), direct: ['203.0.113.7'] })
    expect((await refusal(lookup(SITE, URL_OF_SITE))).word).toBe('unreachable')
    expect(directLookups).toEqual([])
  })
})

describe('a name the system sends outside any proxy', () => {
  it('is looked up on this computer, in the resolver\'s order and at most three', async () => {
    const { lookup, lookups, directLookups } = rig({ answer: 'DIRECT', direct: ['203.0.113.9', '203.0.113.7', '203.0.113.7', '2001:db8::7', '203.0.113.8'] })
    expect(await lookup(SITE, URL_OF_SITE)).toEqual(['203.0.113.9', '203.0.113.7', '2001:db8::7'])
    expect(directLookups).toEqual([SITE])
    expect(lookups).toEqual([])
  })

  it('is not found when this computer gives nothing or fails', async () => {
    expect((await refusal(rig({ answer: 'DIRECT', direct: [] }).lookup(SITE, URL_OF_SITE))).word).toBe('not-found')
    expect((await refusal(rig({ answer: 'DIRECT', direct: new Error('ENOTFOUND') }).lookup(SITE, URL_OF_SITE))).word).toBe('not-found')
  })
})

describe('what never reaches a lookup', () => {
  it('is a name the verifier serves, in either spelling, and an onion name', async () => {
    const { lookup, asked, lookups, directLookups } = rig({ answer: 'DIRECT', direct: ['127.0.0.1'] })
    for (const host of ['vitalik.eth', 'vitalik.eth.', 'abcdefghijklmnop.onion']) expect((await refusal(lookup(host, `https://${host}/`))).word, host).toBe('refused')
    expect(asked).toEqual([])
    expect(lookups).toEqual([])
    expect(directLookups).toEqual([])
  })

  it('is an address literal, which is its own answer, bracketed or not', async () => {
    const { lookup, asked } = rig({ answer: 'PROXY a.test:1' })
    expect(await lookup('203.0.113.7', 'https://203.0.113.7/')).toEqual(['203.0.113.7'])
    expect(await lookup('[2001:db8::7]', 'https://[2001:db8::7]/')).toEqual(['2001:db8::7'])
    expect(asked).toEqual([])
  })

  it('is any name when the system\'s answer cannot be had or read', async () => {
    expect((await refusal(rig({ answer: new Error('slow') }).lookup(SITE, URL_OF_SITE))).word).toBe('unsure')
    expect((await refusal(rig({ answer: 'garbage' }).lookup(SITE, URL_OF_SITE))).word).toBe('unsure')
    expect((await refusal(rig({ answer: 'QUIC a.test:443' }).lookup(SITE, URL_OF_SITE))).word).toBe('refused')
  })
})
