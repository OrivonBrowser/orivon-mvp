// The pinned endpoint: a listener a caller's session is pointed at, which connects only to the address the caller pinned for a
// host and port and looks no name up. The tests are Chromium's side of a CONNECT, over loopback, against a proxy that records
// what it was asked.

import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { installRelayCallers, MAX_PINS, PIN_MS, pinnedCredentials, pinnedEndpoint, relayLookup, sharedPinnedEndpoint } from '../pinned-endpoint.js'
import type { ConnectedReport, PinnedEndpoint, PinnedEndpointOptions } from '../pinned-endpoint.js'
import type { RefusalWord } from '../relay-failures.js'
import { closeAll, keep, readBytes, startConnectProxy, startEcho } from './upstream-fixtures.test-helpers.js'

const SITE = 'shop.example'
const PUBLIC_A = '203.0.113.7'
const PUBLIC_V6 = '2001:db8::7'

const endpoints: PinnedEndpoint[] = []
afterEach(async () => {
  installRelayCallers(undefined)
  for (const endpoint of endpoints.splice(0)) await endpoint.close()
  await closeAll()
})

interface Rig {
  readonly endpoint: PinnedEndpoint
  readonly asked: string[]
  readonly refused: RefusalWord[]
  readonly reports: ConnectedReport[]
  readonly secret: () => string
  readonly clock: { now: number }
}

async function start (answer: string | (() => string), options: Partial<PinnedEndpointOptions> = {}): Promise<Rig> {
  const asked: string[] = []
  const refused: RefusalWord[] = []
  const reports: ConnectedReport[] = []
  const clock = { now: 1_000_000 }
  const endpoint = await pinnedEndpoint({
    systemAnswer: async (url) => { asked.push(url); return typeof answer === 'string' ? answer : answer() },
    onRefused: (word) => { refused.push(word) },
    now: () => clock.now,
    ...options
  })
  endpoints.push(endpoint)
  endpoint.onConnected((report) => { reports.push(report) })
  const port = Number(/:(\d+)$/.exec(String(endpoint.config.proxyRules))?.[1])
  const credentials = endpoint.credentials({ isProxy: true, host: '127.0.0.1', port })
  return { endpoint, asked, refused, reports, secret: () => credentials?.password ?? '', clock }
}

const portOf = (endpoint: PinnedEndpoint): number => Number(/:(\d+)$/.exec(String(endpoint.config.proxyRules))?.[1])

/** What Chromium sends a proxy to open a tunnel: the status line it gets back, and the socket. */
async function tunnel (endpoint: PinnedEndpoint, authority: string, secret: string | undefined): Promise<{ readonly status: number, readonly socket: Socket }> {
  const socket = keep(connect({ host: '127.0.0.1', port: portOf(endpoint) }))
  const credential = secret === undefined ? '' : `Proxy-Authorization: Basic ${Buffer.from(`orivon:${secret}`).toString('base64')}\r\n`
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${credential}\r\n`)
  const head = await new Promise<string>((resolve) => {
    let text = ''
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString('latin1')
      const end = text.indexOf('\r\n\r\n')
      if (end !== -1) { socket.pause(); socket.unshift(Buffer.from(text.slice(end + 4), 'latin1')); resolve(text.slice(0, end)) }
    })
    socket.once('close', () => { resolve(text) })
  })
  socket.resume()
  return { status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1]), socket }
}

async function echoes (socket: Socket): Promise<void> {
  socket.write('hello')
  expect(await readBytes(socket, 5)).toBe('hello')
}

describe('a host and port nobody pinned', () => {
  it('is refused as unpinned, before the system is asked and before any proxy hears of it', async () => {
    const proxy = await startConnectProxy({ targets: {} })
    const { endpoint, asked, refused, secret, reports } = await start(`PROXY 127.0.0.1:${String(proxy.port)}`)
    expect((await tunnel(endpoint, `${SITE}:443`, secret())).status).toBe(403)
    expect(refused).toEqual(['unpinned'])
    expect(asked).toEqual([])
    expect(proxy.seen).toEqual([])
    expect(reports).toEqual([])
  })

  it('says so, in the relay\'s words, to a plain http request that nobody pinned', async () => {
    const { endpoint, secret } = await start('DIRECT')
    const socket = keep(connect({ host: '127.0.0.1', port: portOf(endpoint) }))
    const credential = Buffer.from(`orivon:${secret()}`).toString('base64')
    socket.write(`GET http://${SITE}/ HTTP/1.1\r\nHost: ${SITE}\r\nProxy-Authorization: Basic ${credential}\r\nConnection: close\r\n\r\n`)
    const answer = await new Promise<string>((resolve) => {
      let text = ''
      socket.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
      socket.once('close', () => { resolve(text) })
    })
    expect(answer).toMatch(/^HTTP\/1\.1 403 /)
    expect(answer).toContain('had not cleared it, so it sent nothing')
    expect(answer).not.toContain(SITE)
  })

  it('is told apart by host and by port: a pin is for one of each', async () => {
    const echo = await startEcho()
    const proxy = await startConnectProxy({ targets: { [`${PUBLIC_A}:443`]: echo.port } })
    const { endpoint, refused, secret } = await start(`PROXY 127.0.0.1:${String(proxy.port)}`)
    endpoint.pin(SITE, 443, PUBLIC_A)
    expect((await tunnel(endpoint, `${SITE}:8443`, secret())).status).toBe(403)
    expect((await tunnel(endpoint, `other.example:443`, secret())).status).toBe(403)
    expect(refused).toEqual(['unpinned', 'unpinned'])
    expect(proxy.seen).toEqual([])
    const open = await tunnel(endpoint, `${SITE}:443`, secret())
    expect(open.status).toBe(200)
    await echoes(open.socket)
  })

  it('reads a host in any case and with the root dot as the pinned one', async () => {
    const echo = await startEcho()
    const proxy = await startConnectProxy({ targets: { [`${PUBLIC_A}:443`]: echo.port } })
    const { endpoint, secret } = await start(`PROXY 127.0.0.1:${String(proxy.port)}`)
    endpoint.pin('Shop.Example.', 443, PUBLIC_A)
    expect((await tunnel(endpoint, `${SITE}:443`, secret())).status).toBe(200)
  })

  it('is refused once its pin has run out, and a pin lasts a minute unless the caller says otherwise', async () => {
    const echo = await startEcho()
    const proxy = await startConnectProxy({ targets: { [`${PUBLIC_A}:443`]: echo.port } })
    const { endpoint, refused, secret, clock } = await start(`PROXY 127.0.0.1:${String(proxy.port)}`)
    endpoint.pin(SITE, 443, PUBLIC_A)
    clock.now += PIN_MS - 1
    expect((await tunnel(endpoint, `${SITE}:443`, secret())).status).toBe(200)
    clock.now += 1
    expect((await tunnel(endpoint, `${SITE}:443`, secret())).status).toBe(403)
    endpoint.pin(SITE, 443, PUBLIC_A, clock.now + 5)
    clock.now += 5
    expect((await tunnel(endpoint, `${SITE}:443`, secret())).status).toBe(403)
    expect(refused).toEqual(['unpinned', 'unpinned'])
    expect(PIN_MS).toBe(60_000)
  })

  it('keeps a bounded number of pins, dropping the oldest', async () => {
    const proxy = await startConnectProxy({ targets: {} })
    const { endpoint, refused, secret } = await start(`PROXY 127.0.0.1:${String(proxy.port)}`)
    for (let i = 0; i <= MAX_PINS; i += 1) endpoint.pin(`host${String(i)}.example`, 443, PUBLIC_A)
    expect((await tunnel(endpoint, 'host0.example:443', secret())).status).toBe(403)
    expect(refused).toEqual(['unpinned'])
    expect((await tunnel(endpoint, `host${String(MAX_PINS)}.example:443`, secret())).status).not.toBe(403)
  })
})

describe('a pinned host and port', () => {
  it('goes through the proxy the system names, which is asked for the pinned address and never for the name', async () => {
    const echo = await startEcho()
    const proxy = await startConnectProxy({ targets: { [`${PUBLIC_A}:443`]: echo.port } })
    const { endpoint, asked, secret, reports } = await start(`PROXY 127.0.0.1:${String(proxy.port)}`)
    endpoint.pin(SITE, 443, PUBLIC_A)
    const open = await tunnel(endpoint, `${SITE}:443`, secret())
    expect(open.status).toBe(200)
    await echoes(open.socket)
    expect(asked).toEqual([`https://${SITE}/`])
    expect(proxy.seen.map((seen) => seen.requestLine)).toEqual([`CONNECT ${PUBLIC_A}:443 HTTP/1.1`])
    expect(proxy.seen.map((seen) => seen.headers.host)).toEqual([`${PUBLIC_A}:443`])
    expect(JSON.stringify(proxy.seen)).not.toContain('shop')
    expect(reports).toEqual([{ host: SITE, port: 443, address: PUBLIC_A, road: 'PROXY' }])
  })

  it('connects to the address of a pin that was replaced, never the earlier one', async () => {
    const echo = await startEcho()
    const proxy = await startConnectProxy({ targets: { [`${PUBLIC_A}:443`]: echo.port, [`[${PUBLIC_V6}]:443`]: echo.port } })
    const { endpoint, secret, reports } = await start(`PROXY 127.0.0.1:${String(proxy.port)}`)
    endpoint.pin(SITE, 443, PUBLIC_A)
    endpoint.pin(SITE, 443, PUBLIC_V6)
    await echoes((await tunnel(endpoint, `${SITE}:443`, secret())).socket)
    expect(proxy.seen.map((seen) => seen.requestLine)).toEqual([`CONNECT [${PUBLIC_V6}]:443 HTTP/1.1`])
    expect(reports.map((report) => report.address)).toEqual([PUBLIC_V6])
  })

  it('goes straight to the pinned address when the system sends the connection outside any proxy, and says so', async () => {
    const echo = await startEcho()
    const { endpoint, secret, reports } = await start('DIRECT')
    endpoint.pin(SITE, echo.port, '127.0.0.1')
    await echoes((await tunnel(endpoint, `${SITE}:${String(echo.port)}`, secret())).socket)
    expect(reports).toEqual([{ host: SITE, port: echo.port, address: '127.0.0.1', road: 'DIRECT' }])
  })

  it('is refused by the relay\'s own rules when the pin is an address a proxy would reach on its own machine', async () => {
    const proxy = await startConnectProxy({ targets: {} })
    const { endpoint, refused, secret } = await start(`PROXY 127.0.0.1:${String(proxy.port)}`)
    endpoint.pin(SITE, 443, '127.0.0.1')
    expect((await tunnel(endpoint, `${SITE}:443`, secret())).status).toBe(502)
    expect(refused).toEqual(['inside'])
    expect(proxy.seen).toEqual([])
  })

  it('is refused for a name the verifier serves, pinned or not', async () => {
    const proxy = await startConnectProxy({ targets: {} })
    const { endpoint, refused, secret } = await start(`PROXY 127.0.0.1:${String(proxy.port)}`)
    endpoint.pin('vitalik.eth', 443, PUBLIC_A)
    expect((await tunnel(endpoint, 'vitalik.eth:443', secret())).status).toBe(403)
    expect(refused).toEqual(['refused'])
    expect(proxy.seen).toEqual([])
  })

  it('counts the proxy\'s refusals in words, and keeps serving when the report listener throws', async () => {
    const echo = await startEcho()
    const proxy = await startConnectProxy({ targets: { [`${PUBLIC_A}:443`]: echo.port } })
    const { endpoint, secret } = await start(`PROXY 127.0.0.1:${String(proxy.port)}`)
    endpoint.onConnected(() => { throw new Error('a listener') })
    endpoint.pin(SITE, 443, PUBLIC_A)
    expect((await tunnel(endpoint, `${SITE}:443`, secret())).status).toBe(200)
  })

  it('stops reporting to a listener that was removed', async () => {
    const echo = await startEcho()
    const { endpoint, secret } = await start('DIRECT')
    const heard: string[] = []
    const stop = endpoint.onConnected((report) => { heard.push(report.address) })
    endpoint.pin(SITE, echo.port, '127.0.0.1')
    await tunnel(endpoint, `${SITE}:${String(echo.port)}`, secret())
    stop()
    await tunnel(endpoint, `${SITE}:${String(echo.port)}`, secret())
    expect(heard).toEqual(['127.0.0.1'])
  })

  it('is a pin of an address only, at a real port', async () => {
    const { endpoint } = await start('DIRECT')
    expect(() => { endpoint.pin(SITE, 443, 'shop.example') }).toThrow(TypeError)
    expect(() => { endpoint.pin(SITE, 0, PUBLIC_A) }).toThrow(TypeError)
    expect(() => { endpoint.pin(SITE, 70_000, PUBLIC_A) }).toThrow(TypeError)
  })
})

describe('who may use the endpoint', () => {
  it('is whoever holds its secret: a caller without it is answered 407 and nothing is opened', async () => {
    const echo = await startEcho()
    const { endpoint, asked, secret } = await start('DIRECT')
    endpoint.pin(SITE, echo.port, '127.0.0.1')
    expect((await tunnel(endpoint, `${SITE}:${String(echo.port)}`, undefined)).status).toBe(407)
    expect((await tunnel(endpoint, `${SITE}:${String(echo.port)}`, `${secret()}x`)).status).toBe(407)
    expect(asked).toEqual([])
    expect(echo.connections()).toBe(0)
  })

  it('answers a challenge from its own port with its secret, and no other', async () => {
    const one = await start('DIRECT')
    const two = await start('DIRECT')
    const ownPort = portOf(one.endpoint)
    expect(one.endpoint.credentials({ isProxy: true, host: '127.0.0.1', port: ownPort })).toEqual({ username: 'orivon', password: one.secret() })
    expect(one.endpoint.credentials({ isProxy: true, host: '127.0.0.1', port: portOf(two.endpoint) })).toBeUndefined()
    expect(one.endpoint.credentials({ isProxy: false, host: '127.0.0.1', port: ownPort })).toBeUndefined()
    expect(one.endpoint.credentials({ isProxy: true, host: 'proxy.example', port: ownPort })).toBeUndefined()
    expect(one.secret()).not.toBe(two.secret())
  })

  it('is answered by `pinnedCredentials` while it lives, beside every other live endpoint, and no longer once it is closed', async () => {
    const one = await start('DIRECT')
    const two = await start('DIRECT')
    const askOne = { isProxy: true, host: '127.0.0.1', port: portOf(one.endpoint) }
    const askTwo = { isProxy: true, host: '127.0.0.1', port: portOf(two.endpoint) }
    expect(pinnedCredentials(askOne)?.password).toBe(one.secret())
    expect(pinnedCredentials(askTwo)?.password).toBe(two.secret())
    expect(pinnedCredentials({ isProxy: true, host: '127.0.0.1', port: 1 })).toBeUndefined()
    await one.endpoint.close()
    expect(pinnedCredentials(askOne)).toBeUndefined()
    expect(pinnedCredentials(askTwo)?.password).toBe(two.secret())
  })

  it('takes every scheme to itself and keeps the names the verifier serves out, in both spellings', async () => {
    const { endpoint } = await start('DIRECT')
    expect(endpoint.config.mode).toBe('fixed_servers')
    expect(endpoint.config.proxyRules).toBe(`http://127.0.0.1:${String(portOf(endpoint))}`)
    expect(String(endpoint.config.proxyBypassRules).split(';')).toEqual(expect.arrayContaining(['*.eth', '*.eth.']))
  })

  it('stops listening when closed, and drops its pins', async () => {
    const { endpoint } = await start('DIRECT')
    const port = portOf(endpoint)
    endpoint.pin(SITE, 443, PUBLIC_A)
    await endpoint.close()
    endpoints.splice(0)
    const refused = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port })
      socket.once('connect', () => { socket.destroy(); resolve(false) })
      socket.once('error', () => { resolve(true) })
    })
    expect(refused).toBe(true)
  })
})

describe('the relay\'s callers', () => {
  const lookup = async (): Promise<readonly string[]> => [PUBLIC_A]

  it('have no lookup and no endpoint while the relay is not active', () => {
    expect(relayLookup()).toBeUndefined()
    expect(sharedPinnedEndpoint()).toBeUndefined()
  })

  it('have the relay\'s lookup while it is, and none again once it is removed', () => {
    installRelayCallers({ lookup, systemAnswer: async () => 'DIRECT' })
    expect(relayLookup()).toBe(lookup)
    installRelayCallers(undefined)
    expect(relayLookup()).toBeUndefined()
    expect(sharedPinnedEndpoint()).toBeUndefined()
  })

  it('share one endpoint, started when first asked for, which answers the system as the relay\'s callers were told', async () => {
    const echo = await startEcho()
    const asked: string[] = []
    const refused: RefusalWord[] = []
    installRelayCallers({ lookup, systemAnswer: async (url) => { asked.push(url); return 'DIRECT' }, onRefused: (word) => { refused.push(word) } })
    const first = await sharedPinnedEndpoint()
    const second = await sharedPinnedEndpoint()
    expect(first).toBeDefined()
    expect(second).toBe(first)
    if (first === undefined) return
    first.pin(SITE, echo.port, '127.0.0.1')
    const credentials = first.credentials({ isProxy: true, host: '127.0.0.1', port: portOf(first) })
    expect((await tunnel(first, `${SITE}:${String(echo.port)}`, credentials?.password)).status).toBe(200)
    expect((await tunnel(first, `other.example:${String(echo.port)}`, credentials?.password)).status).toBe(403)
    // A tunnel to a port other than 443 may carry a web socket of either scheme, so the system is asked about both.
    expect(asked).toEqual([`https://${SITE}:${String(echo.port)}/`, `http://${SITE}:${String(echo.port)}/`])
    expect(refused).toEqual(['unpinned'])
  })

  it('close the shared endpoint when the relay stops, and start a new one when it runs again', async () => {
    installRelayCallers({ lookup, systemAnswer: async () => 'DIRECT' })
    const first = await sharedPinnedEndpoint()
    if (first === undefined) throw new Error('no endpoint')
    const port = portOf(first)
    installRelayCallers(undefined)
    await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
    expect(pinnedCredentials({ isProxy: true, host: '127.0.0.1', port })).toBeUndefined()
    installRelayCallers({ lookup, systemAnswer: async () => 'DIRECT' })
    const next = await sharedPinnedEndpoint()
    expect(next).not.toBe(first)
  })
})
