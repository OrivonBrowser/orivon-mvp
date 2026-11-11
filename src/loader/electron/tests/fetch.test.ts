import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetSystemSettings, systemSettingsAre } from '../../../main/route/tests/mirror-status.test-helpers.js'

beforeEach(() => { systemSettingsAre() })
afterEach(() => { forgetSystemSettings() })

// electronFetch and netFetch both dynamically import 'electron' (see
// electron/fetch.ts's own header for why) -- mocked here so this file can
// assert what they hand `net.request`/`net.resolveHost`, and how they treat
// each redirect, without a real network call or a real Electron process.
// test/app-loading/e2e-loader-adapter.test.ts proves the same against a real server.
vi.mock('electron', () => ({
  net: { request: vi.fn(), resolveHost: vi.fn(), fetch: vi.fn() },
  session: { defaultSession: { name: 'default', resolveProxy: vi.fn() } }
}))

const { net, session } = await import('electron')
const { setOwnRequests } = await import('../../../main/route/own-requests.js')
const { installRelayCallers } = await import('../../../main/route/name-relay/pinned-endpoint.js')
const { OWN_READ_HEADER } = await import('../../fetch/content-root.js')
const { ownReadToken } = await import('../../fetch/own-read.js')
const { MAX_REDIRECTS, electronFetch, fetchFromVerifier, netFetch, redirectRefusal } = await import('../fetch.js')

const requestMock = vi.mocked(net.request)
const resolveHostMock = vi.mocked(net.resolveHost)

/** A ClientRequest double: `hops` redirect targets, announced in turn once `end()` is called, then a 200 whose body is `body`. */
function fakeRequest (hops: readonly string[], body = 'ok'): EventEmitter & { followRedirect: ReturnType<typeof vi.fn>, abort: ReturnType<typeof vi.fn>, setHeader: ReturnType<typeof vi.fn>, end: () => void } {
  const request = Object.assign(new EventEmitter(), { followRedirect: vi.fn(), abort: vi.fn(), setHeader: vi.fn(), end: () => {} })
  request.end = () => {
    queueMicrotask(() => {
      for (const target of hops) {
        const before = request.followRedirect.mock.calls.length
        request.emit('redirect', 302, 'GET', target, {})
        if (request.followRedirect.mock.calls.length === before) return
      }
      const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-length': String(body.length) } })
      request.emit('response', response)
      response.end(body)
    })
  }
  return request
}

afterEach(() => {
  requestMock.mockReset()
  resolveHostMock.mockReset()
})

describe('redirectRefusal', () => {
  it('allows a hop that stays on the requested origin, and refuses one to another scheme, host or port', () => {
    expect(redirectRefusal('https://app.example/index.html', 'https://app.example/', 0)).toBeNull()
    expect(redirectRefusal('https://app.example/a', 'http://app.example/a', 0)).toMatch(/another origin/)
    expect(redirectRefusal('https://app.example/a', 'https://cdn.example/a', 0)).toMatch(/another origin/)
    expect(redirectRefusal('https://app.example/a', 'https://app.example:8443/a', 0)).toMatch(/another origin/)
  })

  it(`refuses the hop after ${String(MAX_REDIRECTS)}`, () => {
    expect(redirectRefusal('https://app.example/a', 'https://app.example/b', MAX_REDIRECTS)).toMatch(/redirects/)
  })
})

describe('netFetch', () => {
  it('asks net.request for a manual-redirect, cookie-less GET', async () => {
    requestMock.mockReturnValue(fakeRequest([]) as never)
    await netFetch('https://x.example/a.js', new AbortController().signal)

    expect(requestMock).toHaveBeenCalledExactlyOnceWith({ url: 'https://x.example/a.js', method: 'GET', credentials: 'omit', useSessionCookies: false, redirect: 'manual' })
  })

  it('sends the extra request headers it is given, and none otherwise', async () => {
    const conditional = Object.assign(fakeRequest([]), { setHeader: vi.fn() })
    requestMock.mockReturnValue(conditional as never)
    await netFetch('https://x.example/.well-known/orivon.json', new AbortController().signal, { 'if-none-match': '"v1"' })
    expect(conditional.setHeader).toHaveBeenCalledExactlyOnceWith('if-none-match', '"v1"')

    const plain = Object.assign(fakeRequest([]), { setHeader: vi.fn() })
    requestMock.mockReturnValue(plain as never)
    await netFetch('https://x.example/a.js', new AbortController().signal)
    expect(plain.setHeader).not.toHaveBeenCalled()
  })

  it('follows a same-origin redirect (a static host\'s /index.html -> /) and returns the final body under the requested url', async () => {
    const request = fakeRequest(['https://x.example/'], '<h1>hi</h1>')
    requestMock.mockReturnValue(request as never)

    const response = await netFetch('https://x.example/index.html', new AbortController().signal)

    expect(request.followRedirect).toHaveBeenCalledOnce()
    expect(response.ok).toBe(true)
    expect(response.url).toBe('https://x.example/index.html')
    expect(response.headers?.get('Content-Length')).toBe('11')
    expect(await new Response(response.body).text()).toBe('<h1>hi</h1>')
  })

  it('refuses a cross-origin redirect: rejects, and aborts the request', async () => {
    const request = fakeRequest(['https://elsewhere.example/a.js'])
    requestMock.mockReturnValue(request as never)

    await expect(netFetch('https://x.example/a.js', new AbortController().signal)).rejects.toThrow(/another origin/)
    expect(request.followRedirect).not.toHaveBeenCalled()
    expect(request.abort).toHaveBeenCalled()
  })
})

describe('electronFetch', () => {
  it('delegates to net.request once a public address literal clears the guard', async () => {
    requestMock.mockReturnValue(fakeRequest([]) as never)

    await electronFetch('https://8.8.8.8/a.js', ['8.8.8.8'], new AbortController().signal)

    expect(resolveHostMock).not.toHaveBeenCalled()
    expect(requestMock).toHaveBeenCalledOnce()
  })

  it('delegates to net.request once a hostname resolves to only public addresses', async () => {
    resolveHostMock.mockResolvedValue({ endpoints: [{ address: '93.184.216.34', family: 'ipv4' }] } as never)
    requestMock.mockReturnValue(fakeRequest([]) as never)

    await electronFetch('https://cdn.example/a.js', ['93.184.216.34'], new AbortController().signal)

    expect(resolveHostMock).toHaveBeenCalledExactlyOnceWith('cdn.example')
    expect(requestMock).toHaveBeenCalledOnce()
  })

  describe('while the name relay runs', () => {
    afterEach(() => { installRelayCallers(undefined) })

    it('re-checks the host against the relay\'s lookup, never this computer\'s resolver, and fetches once it is public', async () => {
      const lookup = vi.fn(async () => ['93.184.216.34'])
      installRelayCallers({ lookup, systemAnswer: async () => 'PROXY 127.0.0.1:3128' })
      resolveHostMock.mockResolvedValue({ endpoints: [{ address: '10.0.0.5', family: 'ipv4' }] } as never)
      requestMock.mockReturnValue(fakeRequest([]) as never)

      await electronFetch('https://cdn.example/a.js', ['93.184.216.34'], new AbortController().signal)

      expect(lookup).toHaveBeenCalledExactlyOnceWith('cdn.example', 'https://cdn.example/')
      expect(resolveHostMock).not.toHaveBeenCalled()
      expect(requestMock).toHaveBeenCalledOnce()
    })

    it('never fetches when the relay found a private address, whatever this computer\'s resolver would say', async () => {
      installRelayCallers({ lookup: async () => ['10.0.0.5'], systemAnswer: async () => 'PROXY 127.0.0.1:3128' })
      resolveHostMock.mockResolvedValue({ endpoints: [{ address: '93.184.216.34', family: 'ipv4' }] } as never)
      await expect(electronFetch('https://rebind.example/a.js', ['93.184.216.34'], new AbortController().signal)).rejects.toThrow(/no longer resolves to a public address/)
      expect(resolveHostMock).not.toHaveBeenCalled()
      expect(requestMock).not.toHaveBeenCalled()
    })

    it('never fetches when the relay found no address or could not look up', async () => {
      installRelayCallers({ lookup: async () => [], systemAnswer: async () => 'PROXY 127.0.0.1:3128' })
      await expect(electronFetch('https://nowhere.example/a.js', [], new AbortController().signal)).rejects.toThrow(/resolved to no addresses/)
      installRelayCallers({ lookup: async () => { throw new Error('not-found') }, systemAnswer: async () => 'PROXY 127.0.0.1:3128' })
      await expect(electronFetch('https://nowhere.example/a.js', [], new AbortController().signal)).rejects.toThrow('not-found')
      expect(resolveHostMock).not.toHaveBeenCalled()
      expect(requestMock).not.toHaveBeenCalled()
    })
  })

  it('does not look the host of a website with a tunnel of its own up here, with the whole browser off the tunnel', async () => {
    setOwnRequests({ everywhere: () => false, isRouted: () => true, tunnel: async () => new Response(''), direct: async () => new Response(''), directSession: () => ({}), siteTunnelled: (origin) => origin === 'https://hidden.onion.example' })
    try {
      requestMock.mockReturnValue(fakeRequest([]) as never)
      await electronFetch('https://hidden.onion.example/a.js', [], new AbortController().signal)
      expect(resolveHostMock).not.toHaveBeenCalled()
      expect(requestMock).toHaveBeenCalledOnce()
    } finally {
      setOwnRequests(undefined)
    }
  })

  it('never calls net.request when a literal address fails the guard', async () => {
    await expect(electronFetch('https://127.0.0.1/a.js', [], new AbortController().signal)).rejects.toThrow(/not a public address literal/)
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('never calls net.request when a hostname resolves to a private address', async () => {
    resolveHostMock.mockResolvedValue({ endpoints: [{ address: '10.0.0.5', family: 'ipv4' }] } as never)
    await expect(electronFetch('https://rebind.example/a.js', ['93.184.216.34'], new AbortController().signal)).rejects.toThrow(/no longer resolves to a public address/)
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('never calls net.request when a hostname resolves to no addresses at all', async () => {
    resolveHostMock.mockResolvedValue({ endpoints: [] } as never)
    await expect(electronFetch('https://nowhere.example/a.js', [], new AbortController().signal)).rejects.toThrow(/resolved to no addresses/)
    expect(requestMock).not.toHaveBeenCalled()
  })
})

describe('netFetch, for a name the verifier serves', () => {
  const resolveProxyMock = vi.mocked(session.defaultSession.resolveProxy)
  // The session remembers its answers for a few seconds; each test sets its own.
  afterEach(() => { resolveProxyMock.mockReset() })

  it('is not sent when the session it is made in would use a proxy, and fails in the words the sheet uses', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    resolveProxyMock.mockResolvedValue('PROXY 127.0.0.1:3128')
    await expect(netFetch('https://app.eth/.well-known/orivon.json', new AbortController().signal)).rejects.toThrow('Your system proxy would see this name, so Orivon did not open it.')
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('is sent when that session sends the name to the verifier', async () => {
    resolveProxyMock.mockResolvedValue('DIRECT')
    requestMock.mockReturnValue(fakeRequest([]) as never)
    await netFetch('https://ok.eth/a.js', new AbortController().signal)
    expect(resolveProxyMock).toHaveBeenCalledWith('https://ok.eth/')
    expect(requestMock).toHaveBeenCalledOnce()
  })

  it('asks the session of the website\'s tunnel profile when the request is made in it, not the default one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const profile = { resolveProxy: vi.fn(async () => 'PROXY 127.0.0.1:3128') }
    setOwnRequests({ everywhere: () => false, isRouted: () => true, tunnel: async () => new Response(''), direct: async () => new Response(''), directSession: () => ({}), siteSession: async () => profile })
    try {
      await expect(netFetch('https://profile-site.eth/a.js', new AbortController().signal)).rejects.toThrow('Your system proxy would see this name')
      expect(profile.resolveProxy).toHaveBeenCalledOnce()
      expect(resolveProxyMock).not.toHaveBeenCalled()
      expect(requestMock).not.toHaveBeenCalled()
    } finally {
      setOwnRequests(undefined)
    }
  })

  it('asks nothing for any other host', async () => {
    requestMock.mockReturnValue(fakeRequest([]) as never)
    await netFetch('https://example.com/a.js', new AbortController().signal)
    expect(resolveProxyMock).not.toHaveBeenCalled()
  })

  it('carries the mark of the shell\'s own reads, with the headers it was given, and sends the mark to no other host', async () => {
    resolveProxyMock.mockResolvedValue('DIRECT')
    const sent = fakeRequest([])
    requestMock.mockReturnValue(sent as never)
    await netFetch('https://ok.eth/a.js', new AbortController().signal, { 'x-orivon-content-root': 'bafy' })
    expect(sent.setHeader).toHaveBeenCalledWith('x-orivon-content-root', 'bafy')
    expect(sent.setHeader).toHaveBeenCalledWith(OWN_READ_HEADER, ownReadToken())

    const other = fakeRequest([])
    requestMock.mockReturnValue(other as never)
    await netFetch('https://example.com/a.js', new AbortController().signal, { accept: '*/*' })
    expect(other.setHeader).toHaveBeenCalledTimes(1)
    expect(other.setHeader).not.toHaveBeenCalledWith(OWN_READ_HEADER, expect.anything())
  })
})

describe('fetchFromVerifier, for a name the verifier serves', () => {
  const resolveProxyMock = vi.mocked(session.defaultSession.resolveProxy)
  const fetchMock = vi.mocked(net.fetch)
  const init = (): { method: string, headers: Record<string, string>, signal: AbortSignal } => ({ method: 'GET', headers: {}, signal: new AbortController().signal })
  afterEach(() => { resolveProxyMock.mockReset(); fetchMock.mockReset() })

  it('is not sent when the default session would use a proxy', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    resolveProxyMock.mockResolvedValue('PROXY 127.0.0.1:3128')
    await expect(fetchFromVerifier('https://app.eth/index.html', init())).rejects.toThrow('Your system proxy would see this name')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is sent when the name goes to the verifier', async () => {
    resolveProxyMock.mockResolvedValue('DIRECT')
    fetchMock.mockResolvedValue(new Response('ok'))
    await fetchFromVerifier('https://app.eth/index.html', init())
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('carries the mark of the shell\'s own reads beside the headers it was given, so the verifier\'s server never hands it back to this handler', async () => {
    resolveProxyMock.mockResolvedValue('DIRECT')
    fetchMock.mockResolvedValue(new Response('ok'))
    await fetchFromVerifier('https://app.eth/index.html', { ...init(), headers: { 'x-orivon-expect-leaf': 'sha256:abc' } })
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: { 'x-orivon-expect-leaf': 'sha256:abc', [OWN_READ_HEADER]: ownReadToken() } })
  })

  describe('for an app whose tunnel entry gives it a profile', () => {
    const profile = { resolveProxy: vi.fn(async () => 'DIRECT') }
    const through = (siteSession: (origin: string) => Promise<object | undefined>): void => {
      setOwnRequests({ everywhere: () => false, isRouted: () => true, tunnel: async () => new Response(''), direct: async () => new Response(''), directSession: () => ({}), siteSession })
    }
    afterEach(() => { setOwnRequests(undefined); profile.resolveProxy.mockClear() })

    it('reads in that profile\'s session, which carries the route of its tunnel to the verifier, and never in the default one', async () => {
      through(async (origin) => origin === 'https://tunnelled.eth' ? profile : undefined)
      const sent = fakeRequest([])
      requestMock.mockReturnValue(sent as never)
      const response = await fetchFromVerifier('https://tunnelled.eth/app.js', { ...init(), headers: { 'x-orivon-expect-leaf': 'sha256:abc' } })
      expect(await response.text()).toBe('ok')
      expect(fetchMock).not.toHaveBeenCalled()
      expect(requestMock).toHaveBeenCalledOnce()
      expect(requestMock.mock.calls[0]?.[0]).toMatchObject({ url: 'https://tunnelled.eth/app.js', session: profile, redirect: 'error', credentials: 'omit' })
      expect(sent.setHeader).toHaveBeenCalledWith('x-orivon-expect-leaf', 'sha256:abc')
      expect(sent.setHeader).toHaveBeenCalledWith(OWN_READ_HEADER, ownReadToken())
    })

    it('asks that profile\'s session whether a proxy would see the name, and sends nothing when one would', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const proxied = { resolveProxy: vi.fn(async () => 'PROXY 127.0.0.1:3128') }
      through(async () => proxied)
      await expect(fetchFromVerifier('https://tunnelled.eth/app.js', init())).rejects.toThrow('Your system proxy would see this name')
      expect(proxied.resolveProxy).toHaveBeenCalledOnce()
      expect(resolveProxyMock).not.toHaveBeenCalled()
      expect(requestMock).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('reads in the default session for an app with no entry, and sends nothing when its route cannot be had', async () => {
      through(async () => undefined)
      resolveProxyMock.mockResolvedValue('DIRECT')
      fetchMock.mockResolvedValue(new Response('ok'))
      await fetchFromVerifier('https://plain.eth/app.js', init())
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(requestMock).not.toHaveBeenCalled()

      fetchMock.mockClear()
      through(async () => { throw new Error('the tunnel for this site is not available') })
      await expect(fetchFromVerifier('https://plain.eth/app.js', init())).rejects.toThrow('the tunnel for this site is not available')
      expect(fetchMock).not.toHaveBeenCalled()
      expect(requestMock).not.toHaveBeenCalled()
    })
  })
})
