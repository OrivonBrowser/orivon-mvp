// A tab's icon read from another host while the name relay runs: the host is looked up by the relay, judged on every address
// found, pinned to the first, and read through the pinned endpoint, so the proxy is asked for that address and never for the name.
// The network request is scripted; the relay's lookup, the pinned endpoint and the proxy it connects through are real.

import type { Session } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installRelayCallers } from '../../route/name-relay/pinned-endpoint.js'
import type { PinnedEndpoint } from '../../route/name-relay/pinned-endpoint.js'
import { RelayRefusal } from '../../route/name-relay/relay-failures.js'
import { closeAll, keep, readBytes, startConnectProxy, startEcho } from '../../route/name-relay/tests/upstream-fixtures.test-helpers.js'
import type { ConnectProxy } from '../../route/name-relay/tests/upstream-fixtures.test-helpers.js'

const { madeSessions } = vi.hoisted(() => ({ madeSessions: [] as Array<{ partition: string, setProxy: ReturnType<typeof vi.fn> }> }))
vi.mock('electron', () => ({
  net: { request: vi.fn() },
  session: {
    defaultSession: { resolveProxy: vi.fn() },
    fromPartition: vi.fn((partition: string) => { const made = { partition, setProxy: vi.fn(async () => {}) }; madeSessions.push(made); return made })
  }
}))

const { net } = await import('electron')
const { fetchFaviconDataUrlCached } = await import('../favicon-fetch.js')
const { mockRequestOnce, PNG_BYTES, PUBLIC_PAGE, requests, respondOk } = await import('./favicon.test-helpers.js')

const PUBLIC_A = '93.184.216.34'
const PUBLIC_B = '93.184.216.35'
const PRIVATE = '192.168.1.5'

const sessionsUsed = (): unknown[] => vi.mocked(net.request).mock.calls.map(([options]) => (options as unknown as { session?: unknown }).session)

interface Relay {
  readonly lookups: Array<[string, string]>
  readonly proxy: ConnectProxy
  readonly echoPort: number
}

/** The relay as a caller sees it: a lookup over `names`, the system naming a proxy that tunnels each address to a local echo. */
async function startRelay (names: Record<string, readonly string[] | Error>): Promise<Relay> {
  const echo = await startEcho()
  const proxy = await startConnectProxy({ targets: { [`${PUBLIC_A}:443`]: echo.port, [`${PUBLIC_B}:443`]: echo.port } })
  const lookups: Array<[string, string]> = []
  installRelayCallers({
    lookup: async (host, url) => {
      lookups.push([host, url])
      const found = names[host]
      if (found === undefined) throw new RelayRefusal('not-found')
      if (found instanceof Error) throw found
      return found
    },
    systemAnswer: async () => `PROXY 127.0.0.1:${String(proxy.port)}`
  })
  return { lookups, proxy, echoPort: echo.port }
}

/** Chromium's side of a CONNECT to the pinned endpoint the favicon fetch pointed its session at. */
async function connectThroughEndpoint (authority: string): Promise<number> {
  const { sharedPinnedEndpoint } = await import('../../route/name-relay/pinned-endpoint.js')
  const endpoint = (await sharedPinnedEndpoint()) as PinnedEndpoint
  const port = Number(/:(\d+)$/.exec(String(endpoint.config.proxyRules))?.[1])
  const credentials = endpoint.credentials({ isProxy: true, host: '127.0.0.1', port })
  const { connect } = await import('node:net')
  const socket = keep(connect({ host: '127.0.0.1', port }))
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Basic ${Buffer.from(`orivon:${credentials?.password ?? ''}`).toString('base64')}\r\n\r\n`)
  const head = await readBytes(socket, 12)
  return Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1])
}

beforeEach(() => {
  vi.mocked(net.request).mockReset()
  requests.length = 0
  madeSessions.length = 0
})
afterEach(async () => {
  installRelayCallers(undefined)
  await closeAll()
})

describe('while the name relay does not run', () => {
  it('reads an icon as it always did: no pinned session, the lookup this computer\'s own', async () => {
    mockRequestOnce((request) => { request.emit('response', respondOk(200, [PNG_BYTES])) })
    await expect(fetchFaviconDataUrlCached(`https://${PUBLIC_A}/icon.png`, PUBLIC_PAGE, () => false)).resolves.toMatch(/^data:image\/png/)
    expect(sessionsUsed()).toEqual([undefined])
    expect(madeSessions).toEqual([])
  })
})

describe('while the name relay runs', () => {
  it('looks the host up by the relay, judges every address, and reads through the pinned endpoint at the first address', async () => {
    const { lookups, proxy } = await startRelay({ 'cdn.example': [PUBLIC_A, PUBLIC_B] })
    mockRequestOnce((request) => { request.emit('response', respondOk(200, [PNG_BYTES])) })

    await expect(fetchFaviconDataUrlCached('https://cdn.example/icon.png', PUBLIC_PAGE, () => false)).resolves.toMatch(/^data:image\/png/)

    expect(lookups.every(([host, url]) => host === 'cdn.example' && url === 'https://cdn.example/')).toBe(true)
    expect(madeSessions).toHaveLength(1)
    expect(madeSessions[0]?.setProxy).toHaveBeenCalledOnce()
    expect(sessionsUsed()).toEqual([madeSessions[0]])
    // The read is what the session's proxy carries: the endpoint connects to the address that was judged, and the proxy never hears the name.
    expect(await connectThroughEndpoint('cdn.example:443')).toBe(200)
    expect(proxy.seen.map((seen) => seen.requestLine)).toEqual([`CONNECT ${PUBLIC_A}:443 HTTP/1.1`])
    expect(JSON.stringify(proxy.seen)).not.toContain('cdn')
    // No other host is pinned: the pin is the one the check cleared.
    expect(await connectThroughEndpoint('elsewhere.example:443')).toBe(403)
  })

  it('refuses a host with an address that is not public, however many are, and makes no request', async () => {
    await startRelay({ 'cdn.example': [PUBLIC_A, PRIVATE], 'inside.example': [PRIVATE], 'empty.example': [] })
    for (const host of ['cdn.example', 'inside.example', 'empty.example']) {
      await expect(fetchFaviconDataUrlCached(`https://${host}/icon.png`, PUBLIC_PAGE, () => false)).resolves.toBeNull()
    }
    expect(net.request).not.toHaveBeenCalled()
    expect(madeSessions).toEqual([])
  })

  it('refuses a host the relay could not look up, and one it refuses to', async () => {
    await startRelay({ 'broken.example': new RelayRefusal('no-answer') })
    await expect(fetchFaviconDataUrlCached('https://broken.example/icon.png', PUBLIC_PAGE, () => false)).resolves.toBeNull()
    await expect(fetchFaviconDataUrlCached('https://unknown.example/icon.png', PUBLIC_PAGE, () => false)).resolves.toBeNull()
    await expect(fetchFaviconDataUrlCached('https://vitalik.eth/icon.png', PUBLIC_PAGE, () => false)).resolves.toBeNull()
    expect(net.request).not.toHaveBeenCalled()
  })

  it('looks the host up again, and pins it, for each hop of a redirect, and refuses a hop that goes somewhere not public', async () => {
    const { lookups } = await startRelay({ 'cdn.example': [PUBLIC_A], 'other-cdn.example': [PUBLIC_B], 'rebind.example': [PRIVATE] })
    mockRequestOnce((request) => { request.emit('redirect', 301, 'GET', 'https://other-cdn.example/icon.png', {}) })
    mockRequestOnce((request) => { request.emit('response', respondOk(200, [PNG_BYTES])) })
    await expect(fetchFaviconDataUrlCached('https://cdn.example/icon.png', PUBLIC_PAGE, () => false)).resolves.toMatch(/^data:image\/png/)
    expect([...new Set(lookups.map(([host]) => host))]).toEqual(['cdn.example', 'other-cdn.example'])
    expect(await connectThroughEndpoint('other-cdn.example:443')).toBe(200)

    vi.mocked(net.request).mockReset()
    mockRequestOnce((request) => { request.emit('redirect', 302, 'GET', 'https://rebind.example/icon.png', {}) })
    await expect(fetchFaviconDataUrlCached('https://cdn.example/other.png', PUBLIC_PAGE, () => false)).resolves.toBeNull()
    expect(net.request).toHaveBeenCalledTimes(1)
  })

  it('reads a literal public address through the endpoint pinned to itself, with no lookup', async () => {
    const { lookups, proxy } = await startRelay({})
    mockRequestOnce((request) => { request.emit('response', respondOk(200, [PNG_BYTES])) })
    await expect(fetchFaviconDataUrlCached(`https://${PUBLIC_A}/icon.png`, PUBLIC_PAGE, () => false)).resolves.toMatch(/^data:image\/png/)
    expect(lookups).toEqual([])
    expect(await connectThroughEndpoint(`${PUBLIC_A}:443`)).toBe(200)
    expect(proxy.seen.map((seen) => seen.requestLine)).toEqual([`CONNECT ${PUBLIC_A}:443 HTTP/1.1`])
  })

  it('shares one pinned session between reads', async () => {
    await startRelay({ 'cdn.example': [PUBLIC_A] })
    mockRequestOnce((request) => { request.emit('response', respondOk(200, [PNG_BYTES])) })
    mockRequestOnce((request) => { request.emit('response', respondOk(200, [PNG_BYTES])) })
    await fetchFaviconDataUrlCached('https://cdn.example/a.png', PUBLIC_PAGE, () => false)
    await fetchFaviconDataUrlCached('https://cdn.example/b.png', PUBLIC_PAGE, () => false)
    expect(madeSessions).toHaveLength(1)
    expect(sessionsUsed()).toEqual([madeSessions[0], madeSessions[0]])
  })

  it('leaves an icon on the page\'s own origin, and an app\'s own route, as they were', async () => {
    const { lookups } = await startRelay({ 'cdn.example': [PUBLIC_A] })
    const route = { name: 'route' } as unknown as Session
    const page = { name: 'page' } as unknown as Session
    mockRequestOnce((request) => { request.emit('response', respondOk(200, [PNG_BYTES])) })
    mockRequestOnce((request) => { request.emit('response', respondOk(200, [PNG_BYTES])) })
    await fetchFaviconDataUrlCached('https://cdn.example/icon.png', PUBLIC_PAGE, () => false, page, async () => route)
    await fetchFaviconDataUrlCached('https://example.com/icon.png', PUBLIC_PAGE, () => false, page, async () => route)
    expect(sessionsUsed()).toEqual([route, page])
    expect(lookups).toEqual([])
    expect(madeSessions).toEqual([])
  })

  it('leaves an icon on loopback, for a page on loopback, to Chromium, which reaches it without a proxy', async () => {
    await startRelay({})
    mockRequestOnce((request) => { request.emit('response', respondOk(200, [PNG_BYTES])) })
    await expect(fetchFaviconDataUrlCached('http://127.0.0.1:3000/icon.png', 'http://127.0.0.1:3000/app', () => false)).resolves.toMatch(/^data:image\/png/)
    expect(sessionsUsed()).toEqual([undefined])
    expect(madeSessions).toEqual([])
  })

  it('keeps loopback away from a public page whether or not the relay runs', async () => {
    await startRelay({})
    await expect(fetchFaviconDataUrlCached('http://127.0.0.1:8080/icon.png', PUBLIC_PAGE, () => false)).resolves.toBeNull()
    expect(net.request).not.toHaveBeenCalled()
  })
})
