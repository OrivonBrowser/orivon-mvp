// The opener behind the listener: given the system's answer for a URL and a lookup, it opens the upstream for a target to an
// address, through the proxy that answer names, and never lets a site's name reach a proxy or a lookup it was not meant for.

import { afterEach, describe, expect, it } from 'vitest'
import { startSocks5Fixture } from '../../../../broker/route/tests/socks5-fixture.test-helpers.js'
import { createRunCertificate } from '../../../../protocols/verifier-host/serve/certificate.js'
import type { FrontTarget } from '../../front.js'
import { createRelayFailures, RelayRefusal } from '../relay-failures.js'
import type { RefusalWord } from '../relay-failures.js'
import { createRelayOpener, RELAY_MAX_OPEN } from '../relay-opener.js'
import type { RelayLookup, RelayLookupQuery } from '../relay-opener.js'
import { closeAll, closedPort, closeLater, keep, readBytes, startConnectProxy, startEcho, startSocks4Proxy } from './upstream-fixtures.test-helpers.js'

afterEach(closeAll)

const SITE = 'shop.example'
const PUBLIC_A = '203.0.113.7'
const PUBLIC_B = '203.0.113.8'
const PUBLIC_C = '203.0.113.9'
const PUBLIC_D = '203.0.113.10'
const PUBLIC_V6 = '2001:db8::7'

type Answer = readonly string[] | RelayRefusal | Error | 'never'
type Answers = Partial<Record<4 | 6, Answer>>

function targetOf (host: string, port = 443, signal: AbortSignal = new AbortController().signal): FrontTarget {
  return { host, port, url: `${port === 80 ? 'http' : 'https'}://${host.includes(':') ? `[${host}]` : host}${port === 80 || port === 443 ? '' : `:${String(port)}`}/`, signal }
}

async function refusal (attempt: Promise<unknown>): Promise<RelayRefusal> {
  const error = await attempt.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(RelayRefusal)
  return error as RelayRefusal
}

function rig (options: {
  answer: string | (() => Promise<string>)
  lookup?: (query: RelayLookupQuery) => Answers
  direct?: readonly string[] | Error
  maxOpen?: number
  roots?: readonly string[]
}) {
  const asked: string[] = []
  const lookups: Array<{ host: string, family: 4 | 6, via: string }> = []
  const directLookups: string[] = []
  const failures = createRelayFailures()
  const lookup: RelayLookup = async (query) => {
    lookups.push({ host: query.host, family: query.family, via: `${query.via.kind} ${query.via.host}:${String(query.via.port)}` })
    const answer = options.lookup?.(query)[query.family] ?? []
    if (answer === 'never') return await new Promise<never>(() => {})
    if (answer instanceof Error) throw answer
    return answer
  }
  const open = createRelayOpener({
    systemAnswer: async (url) => {
      asked.push(url)
      return typeof options.answer === 'string' ? options.answer : await options.answer()
    },
    lookup,
    lookupDirect: async (host) => {
      directLookups.push(host)
      if (options.direct instanceof Error) throw options.direct
      return options.direct ?? []
    },
    failures,
    ...(options.maxOpen === undefined ? {} : { maxOpen: options.maxOpen }),
    ...(options.roots === undefined ? {} : { upstream: { roots: options.roots } })
  })
  return { open, asked, lookups, directLookups, failures }
}

async function echoes (socket: Awaited<ReturnType<ReturnType<typeof rig>['open']>>, text = 'hello'): Promise<void> {
  socket.write(text)
  expect(await readBytes(socket, text.length)).toBe(text)
}

const viaHttp = (port: number): string => `PROXY 127.0.0.1:${String(port)}`

describe('a name behind an HTTP proxy', () => {
  it('is looked up through the proxy it will leave by, and the proxy is asked for the address only', async () => {
    const echo = await startEcho()
    const proxy = await startConnectProxy({ targets: { [`${PUBLIC_A}:443`]: echo.port } })
    const { open, asked, lookups } = rig({ answer: viaHttp(proxy.port), lookup: () => ({ 4: [PUBLIC_A], 6: [] }) })
    const socket = keep(await open(targetOf(SITE)))
    await echoes(socket)
    expect(asked).toEqual([`https://${SITE}/`])
    expect(lookups).toEqual([
      { host: SITE, family: 4, via: `http 127.0.0.1:${String(proxy.port)}` },
      { host: SITE, family: 6, via: `http 127.0.0.1:${String(proxy.port)}` }
    ])
    expect(proxy.seen.map((seen) => seen.requestLine)).toEqual([`CONNECT ${PUBLIC_A}:443 HTTP/1.1`])
    expect(proxy.seen.map((seen) => seen.headers.host)).toEqual([`${PUBLIC_A}:443`])
    expect(JSON.stringify(proxy.seen)).not.toContain('shop')
  })

  it('asks the system about the address of a plain http request as it was written, and tunnels it to the port', async () => {
    const echo = await startEcho()
    const proxy = await startConnectProxy({ targets: { [`${PUBLIC_A}:80`]: echo.port } })
    const { open, asked } = rig({ answer: viaHttp(proxy.port), lookup: () => ({ 4: [PUBLIC_A] }) })
    await echoes(keep(await open({ host: SITE, port: 80, url: `http://${SITE}/a/path?q=1`, signal: new AbortController().signal })))
    expect(asked).toEqual([`http://${SITE}/a/path?q=1`])
    expect(proxy.seen[0]?.requestLine).toBe(`CONNECT ${PUBLIC_A}:80 HTTP/1.1`)
  })

  it('connects as soon as the IPv4 lookup answers, without waiting for the IPv6 one', async () => {
    const echo = await startEcho()
    const proxy = await startConnectProxy({ targets: { [`${PUBLIC_A}:443`]: echo.port } })
    const { open } = rig({ answer: viaHttp(proxy.port), lookup: () => ({ 4: [PUBLIC_A], 6: 'never' }) })
    await echoes(keep(await open(targetOf(SITE))))
  })

  it('waits for the IPv6 lookup when IPv4 names no address', async () => {
    const echo = await startEcho()
    const proxy = await startConnectProxy({ targets: { [`[${PUBLIC_V6}]:443`]: echo.port } })
    const { open } = rig({ answer: viaHttp(proxy.port), lookup: () => ({ 4: [], 6: [PUBLIC_V6] }) })
    await echoes(keep(await open(targetOf(SITE))))
    expect(proxy.seen[0]?.requestLine).toBe(`CONNECT [${PUBLIC_V6}]:443 HTTP/1.1`)
  })

  it('tries IPv4 before IPv6 and the next address only when the proxy could not reach one', async () => {
    const echo = await startEcho()
    const proxy = await startConnectProxy({ targets: { [`${PUBLIC_B}:443`]: echo.port } })
    const { open } = rig({ answer: viaHttp(proxy.port), lookup: () => ({ 4: [PUBLIC_A, PUBLIC_B], 6: [PUBLIC_V6] }) })
    await echoes(keep(await open(targetOf(SITE))))
    expect(proxy.seen.map((seen) => seen.requestLine)).toEqual([`CONNECT ${PUBLIC_A}:443 HTTP/1.1`, `CONNECT ${PUBLIC_B}:443 HTTP/1.1`])
  })

  it('gives up after three addresses, across both families', async () => {
    const proxy = await startConnectProxy({ targets: {} })
    const { open } = rig({ answer: viaHttp(proxy.port), lookup: () => ({ 4: [PUBLIC_A, PUBLIC_B], 6: [PUBLIC_V6, '2001:db8::8'] }) })
    expect((await refusal(open(targetOf(SITE)))).word).toBe('unreachable')
    expect(proxy.seen.map((seen) => seen.requestLine)).toEqual([`CONNECT ${PUBLIC_A}:443 HTTP/1.1`, `CONNECT ${PUBLIC_B}:443 HTTP/1.1`, `CONNECT [${PUBLIC_V6}]:443 HTTP/1.1`])
  })

  it('stops at a proxy that refuses or asks for a sign-in, and does not try the next address', async () => {
    const forbidden = await startConnectProxy({ status: 403 })
    const first = rig({ answer: viaHttp(forbidden.port), lookup: () => ({ 4: [PUBLIC_A, PUBLIC_B] }) })
    expect((await refusal(first.open(targetOf(SITE)))).word).toBe('refused')
    expect(forbidden.seen).toHaveLength(1)
    const signIn = await startConnectProxy({ status: 407 })
    const second = rig({ answer: viaHttp(signIn.port), lookup: () => ({ 4: [PUBLIC_A, PUBLIC_B] }) })
    expect((await refusal(second.open(targetOf(SITE)))).word).toBe('sign-in')
    expect(signIn.seen).toHaveLength(1)
  })

  it('moves to the next proxy of the list only when the first cannot be reached, looking the name up through that one', async () => {
    const echo = await startEcho()
    const alive = await startConnectProxy({ targets: { [`${PUBLIC_A}:443`]: echo.port } })
    const dead = await startConnectProxy({ hangUp: true })
    const { open, lookups } = rig({ answer: `${viaHttp(dead.port)}; ${viaHttp(alive.port)}`, lookup: () => ({ 4: [PUBLIC_A], 6: [] }) })
    await echoes(keep(await open(targetOf(SITE))))
    expect(lookups.map((lookup) => lookup.via)).toEqual([
      `http 127.0.0.1:${String(dead.port)}`, `http 127.0.0.1:${String(dead.port)}`,
      `http 127.0.0.1:${String(alive.port)}`, `http 127.0.0.1:${String(alive.port)}`
    ])
  })

  it('moves on when the lookup cannot pass through the proxy, and stops at any other lookup refusal', async () => {
    const echo = await startEcho()
    const alive = await startConnectProxy({ targets: { [`${PUBLIC_A}:443`]: echo.port } })
    const blocked = (query: RelayLookupQuery): Answers => query.via.port === 1 ? { 4: new RelayRefusal('unreachable'), 6: new RelayRefusal('unreachable') } : { 4: [PUBLIC_A] }
    await echoes(keep(await rig({ answer: `PROXY 127.0.0.1:1; ${viaHttp(alive.port)}`, lookup: blocked }).open(targetOf(SITE))))
    const stopped = rig({ answer: `PROXY 127.0.0.1:1; ${viaHttp(alive.port)}`, lookup: (query) => query.via.port === 1 ? { 4: new RelayRefusal('sign-in'), 6: new RelayRefusal('sign-in') } : { 4: [PUBLIC_A] } })
    expect((await refusal(stopped.open(targetOf(SITE)))).word).toBe('sign-in')
    expect(stopped.lookups.every((lookup) => lookup.via.endsWith(':1'))).toBe(true)
  })

  it('never takes a DIRECT after a proxy: with every proxy down the load fails and nothing is looked up or dialled outside', async () => {
    const direct = await startEcho()
    const dead = await startConnectProxy({ hangUp: true })
    const { open, directLookups } = rig({ answer: `${viaHttp(dead.port)}; DIRECT`, lookup: () => ({ 4: [PUBLIC_A] }), direct: ['127.0.0.1'] })
    expect((await refusal(open(targetOf(SITE, direct.port)))).word).toBe('unreachable')
    expect(directLookups).toEqual([])
    expect(direct.connections()).toBe(0)
  })
})

describe('what the lookup answers', () => {
  const proxy = async (): Promise<string> => viaHttp((await startConnectProxy({ targets: {} })).port)

  it.each<[string, Answers, RefusalWord]>([
    ['no address in either family', { 4: [], 6: [] }, 'not-found'],
    ['not found in both', { 4: new RelayRefusal('not-found'), 6: new RelayRefusal('not-found') }, 'not-found'],
    ['a family that did not answer, the other with no address', { 4: new RelayRefusal('no-answer'), 6: [] }, 'no-answer'],
    ['no address in one, no answer in the other', { 4: [], 6: new RelayRefusal('no-answer') }, 'no-answer'],
    ['a failure that says nothing', { 4: new Error('boom'), 6: [] }, 'no-answer'],
    ['a sign-in', { 4: new RelayRefusal('sign-in'), 6: new RelayRefusal('sign-in') }, 'sign-in']
  ])('is refused, with the word it comes to: %s', async (_name, answers, word) => {
    const { open } = rig({ answer: await proxy(), lookup: () => answers })
    expect((await refusal(open(targetOf(SITE)))).word).toBe(word)
  })

  it('uses the addresses of the family that answered when the other did not', async () => {
    const echo = await startEcho()
    const alive = await startConnectProxy({ targets: { [`${PUBLIC_A}:443`]: echo.port, [`[${PUBLIC_V6}]:443`]: echo.port } })
    const v4 = rig({ answer: viaHttp(alive.port), lookup: () => ({ 4: [PUBLIC_A], 6: new RelayRefusal('no-answer') }) })
    await echoes(keep(await v4.open(targetOf(SITE))))
    const v6 = rig({ answer: viaHttp(alive.port), lookup: () => ({ 4: new RelayRefusal('no-answer'), 6: [PUBLIC_V6] }) })
    await echoes(keep(await v6.open(targetOf(SITE))))
  })
})

describe('an address that means the proxy\'s own machine', () => {
  it('is never sent upstream: with nothing else the load is refused as inside', async () => {
    const proxy = await startConnectProxy({ targets: {} })
    const { open } = rig({ answer: viaHttp(proxy.port), lookup: () => ({ 4: ['127.0.0.1', '169.254.169.254', '0.0.0.0'], 6: ['::1'] }) })
    expect((await refusal(open(targetOf(SITE)))).word).toBe('inside')
    expect(proxy.seen).toHaveLength(0)
  })

  it('is left out of the addresses tried, when the name has others', async () => {
    const echo = await startEcho()
    const proxy = await startConnectProxy({ targets: { [`${PUBLIC_A}:443`]: echo.port } })
    const { open } = rig({ answer: viaHttp(proxy.port), lookup: () => ({ 4: ['127.0.0.1', PUBLIC_A] }) })
    await echoes(keep(await open(targetOf(SITE))))
    expect(proxy.seen.map((seen) => seen.requestLine)).toEqual([`CONNECT ${PUBLIC_A}:443 HTTP/1.1`])
  })

  it('is refused when the page named it as a literal, with no lookup', async () => {
    const proxy = await startConnectProxy({ targets: {} })
    const { open, lookups } = rig({ answer: viaHttp(proxy.port) })
    expect((await refusal(open(targetOf('127.0.0.1')))).word).toBe('inside')
    expect((await refusal(open(targetOf('::1')))).word).toBe('inside')
    expect(lookups).toEqual([])
    expect(proxy.seen).toHaveLength(0)
  })
})

describe('an address given as a literal', () => {
  it('is used as it is, with no lookup', async () => {
    const echo = await startEcho()
    const proxy = await startConnectProxy({ targets: { [`${PUBLIC_A}:443`]: echo.port } })
    const { open, lookups } = rig({ answer: viaHttp(proxy.port) })
    await echoes(keep(await open(targetOf(PUBLIC_A))))
    expect(lookups).toEqual([])
    expect(proxy.seen[0]?.requestLine).toBe(`CONNECT ${PUBLIC_A}:443 HTTP/1.1`)
  })
})

describe('a name the verifier serves, and an onion address', () => {
  it.each(['vitalik.eth', 'vitalik.eth.', 'Vitalik.ETH', 'abc.onion', 'abc.onion.', 'onion'])('is refused before the system, a lookup or a proxy is asked: %s', async (host) => {
    const proxy = await startConnectProxy({ targets: {} })
    const { open, asked, lookups, directLookups } = rig({ answer: viaHttp(proxy.port), lookup: () => ({ 4: [PUBLIC_A] }) })
    const error = await refusal(open(targetOf(host)))
    expect(error.word).toBe('refused')
    expect(error.status).toBe(403)
    expect({ asked, lookups, directLookups, seen: proxy.seen }).toEqual({ asked: [], lookups: [], directLookups: [], seen: [] })
  })
})

describe('the system\'s answer', () => {
  it.each<[string, string | (() => Promise<string>), RefusalWord]>([
    ['one that does not come', async () => { throw new Error('the session did not say which proxy it would use') }, 'unsure'],
    ['one that is not an answer', 'garbage', 'unsure'],
    ['one that is empty', '', 'unsure'],
    ['a proxy of a kind the relay cannot speak', 'QUIC q.example:443', 'refused'],
    ['a SOCKS5 proxy on this computer at Tor\'s usual port', 'SOCKS5 127.0.0.1:9050', 'anonymity'],
    ['a SOCKS4 proxy on this computer at Tor Browser\'s port', 'SOCKS 127.0.0.1:9150', 'anonymity'],
    ['Tor\'s port anywhere in a list', 'PROXY 127.0.0.1:8080; SOCKS5 localhost:9050', 'anonymity']
  ])('%s fails the load, with a lookup of no kind', async (_name, answer, word) => {
    const { open, lookups, directLookups } = rig({ answer, lookup: () => ({ 4: [PUBLIC_A] }), direct: ['127.0.0.1'] })
    expect((await refusal(open(targetOf(SITE)))).word).toBe(word)
    expect([lookups, directLookups]).toEqual([[], []])
  })
})

describe('through SOCKS and HTTPS proxies', () => {
  it('asks a SOCKS5 proxy for the address by its type, never the name', async () => {
    const echo = await startEcho()
    const socks = await startSocks5Fixture({ names: { [`${PUBLIC_A}:443`]: { host: '127.0.0.1', port: echo.port } }, refuseUnmapped: true })
    closeLater(socks.close)
    const { open } = rig({ answer: `SOCKS5 127.0.0.1:${String(socks.port)}`, lookup: () => ({ 4: [PUBLIC_A] }) })
    await echoes(keep(await open(targetOf(SITE))))
    expect(socks.requests.map((request) => [request.destination, request.addressType])).toEqual([[PUBLIC_A, 'ipv4']])
  })

  it('asks a SOCKS4 proxy for an IPv4 address, and looks up no IPv6 one', async () => {
    const echo = await startEcho()
    const socks = await startSocks4Proxy({ targets: { [`${PUBLIC_A}:443`]: echo.port } })
    const { open, lookups } = rig({ answer: `SOCKS 127.0.0.1:${String(socks.port)}`, lookup: () => ({ 4: [PUBLIC_A], 6: [PUBLIC_V6] }) })
    await echoes(keep(await open(targetOf(SITE))))
    expect(lookups.map((lookup) => lookup.family)).toEqual([4])
    expect(socks.seen.map((seen) => seen.address)).toEqual([PUBLIC_A])
  })

  it('goes through an HTTPS proxy it can verify', async () => {
    const certificate = createRunCertificate(new Date(), 30, 'localhost')
    const echo = await startEcho()
    const proxy = await startConnectProxy({ targets: { [`${PUBLIC_A}:443`]: echo.port }, tls: { key: certificate.keyPem, cert: certificate.certPem } })
    const { open, lookups } = rig({ answer: `HTTPS localhost:${String(proxy.port)}`, lookup: () => ({ 4: [PUBLIC_A] }), roots: [certificate.certPem] })
    await echoes(keep(await open(targetOf(SITE))))
    expect(lookups[0]?.via).toBe(`https localhost:${String(proxy.port)}`)
  })
})

describe('a connection the system sends outside any proxy', () => {
  it('is looked up on this computer and dialled to the first address the resolver gave', async () => {
    const echo = await startEcho()
    const { open, lookups, directLookups, asked } = rig({ answer: 'DIRECT', direct: ['127.0.0.1', PUBLIC_A], lookup: () => ({ 4: [PUBLIC_A] }) })
    await echoes(keep(await open(targetOf(SITE, echo.port))))
    expect(directLookups).toEqual([SITE])
    expect(lookups).toEqual([])
    expect(asked).toEqual([`https://${SITE}:${String(echo.port)}/`])
  })

  it.skipIf(process.platform !== 'linux')('goes on to the next address when one is refused', async () => {
    const echo = await startEcho()
    const { open } = rig({ answer: 'DIRECT', direct: ['127.0.0.2', '127.0.0.1'] })
    await echoes(keep(await open(targetOf(SITE, echo.port))))
  })

  it('dials a literal as it is', async () => {
    const echo = await startEcho()
    const { open, directLookups } = rig({ answer: 'DIRECT' })
    await echoes(keep(await open(targetOf('127.0.0.1', echo.port))))
    expect(directLookups).toEqual([])
  })

  it('fails as not found when this computer finds no address, and as unreachable when none can be dialled', async () => {
    expect((await refusal(rig({ answer: 'DIRECT', direct: [] }).open(targetOf(SITE)))).word).toBe('not-found')
    expect((await refusal(rig({ answer: 'DIRECT', direct: new Error('ENOTFOUND') }).open(targetOf(SITE)))).word).toBe('not-found')
    expect((await refusal(rig({ answer: 'DIRECT', direct: ['127.0.0.1'] }).open(targetOf(SITE, await closedPort())))).word).toBe('unreachable')
  })
})

describe('what is remembered of a failure', () => {
  it('is the word, under the host and port the load named', async () => {
    const { open, failures } = rig({ answer: 'garbage' })
    await refusal(open(targetOf(SITE, 8443)))
    expect(failures.reasonFor(SITE, 8443)).toBe('unsure')
    expect(failures.reasonFor(SITE, 443)).toBeUndefined()
  })

  it('is not written for a load that succeeded or that the client gave up', async () => {
    const echo = await startEcho()
    const proxy = await startConnectProxy({ targets: { [`${PUBLIC_A}:443`]: echo.port } })
    const good = rig({ answer: viaHttp(proxy.port), lookup: () => ({ 4: [PUBLIC_A] }) })
    keep(await good.open(targetOf(SITE)))
    expect(good.failures.reasonFor(SITE, 443)).toBeUndefined()
    const controller = new AbortController()
    const slow = rig({ answer: viaHttp(proxy.port), lookup: () => ({ 4: 'never', 6: 'never' }) })
    const attempt = slow.open(targetOf(SITE, 443, controller.signal)).then(() => 'opened', (error: Error) => error.name)
    setTimeout(() => { controller.abort() }, 20)
    expect(await attempt).toBe('AbortError')
    expect(slow.failures.reasonFor(SITE, 443)).toBeUndefined()
  })
})

describe('a refusal that comes after the client gave up', () => {
  it('is not remembered for the host', async () => {
    const controller = new AbortController()
    const { open, failures } = rig({ answer: async () => { controller.abort(); throw new Error('the session did not say which proxy it would use') } })
    expect((await refusal(open(targetOf(SITE, 443, controller.signal)))).word).toBe('unsure')
    expect(failures.reasonFor(SITE, 443)).toBeUndefined()
  })
})

describe('the number of connections', () => {
  it('is bounded: past the limit a connection is answered 503, and one opens again when another has closed', async () => {
    const echo = await startEcho()
    const proxy = await startConnectProxy({ targets: { [`${PUBLIC_A}:443`]: echo.port } })
    const { open } = rig({ answer: viaHttp(proxy.port), lookup: () => ({ 4: [PUBLIC_A] }), maxOpen: 2 })
    const first = keep(await open(targetOf(SITE)))
    keep(await open(targetOf(SITE)))
    const refused = await refusal(open(targetOf(SITE)))
    expect(refused.status).toBe(503)
    expect(refused.word).toBe('refused')
    first.destroy()
    await new Promise<void>((resolve) => { first.once('close', resolve) })
    keep(await open(targetOf(SITE)))
  })

  it('does not count a connection that failed to open', async () => {
    const { open } = rig({ answer: 'garbage', maxOpen: 1 })
    for (let i = 0; i < 3; i += 1) expect((await refusal(open(targetOf(SITE)))).word).toBe('unsure')
  })

  it('has a limit of 512 unless told otherwise', () => {
    expect(RELAY_MAX_OPEN).toBe(512)
  })
})
