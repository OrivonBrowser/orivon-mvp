import { afterEach, describe, expect, it, vi } from 'vitest'
import { noteProxySet } from '../proxy-answers.js'
import { createRefusalNotes, namesVerifierHost, noteRefusal, PROXY_WOULD_SEE_NAME, proxyRefusals, proxyWouldCarry, refuseWhenProxySees, refusingProxiedNames, verifierNameFilter, verifierNameGuard } from '../verifier-name-guard.js'

afterEach(() => { vi.restoreAllMocks() })

describe('which requests name a host the verifier serves', () => {
  it('takes a name under a protocol\'s suffix, in any scheme a proxy can carry, with or without the root dot', () => {
    for (const url of ['https://name.eth/', 'http://name.eth/a?b=c', 'wss://a.b.eth/socket', 'ws://name.eth:8080/', 'https://NAME.ETH./x', 'https://x.ipfs.orivon/', 'https://x.bzz.orivon/path', 'https://a..eth/']) expect(namesVerifierHost(url), url).toBe(true)
  })

  it('leaves every other host alone', () => {
    for (const url of ['https://example.com/', 'https://name.eth.example.com/', 'https://eth/', 'https://notorivon/', 'http://127.0.0.1:8080/', 'https://example.com/name.eth', 'not a url', '']) expect(namesVerifierHost(url), url).toBe(false)
  })

  it('names, for Electron\'s filter, each suffix under each scheme with and without the root dot', () => {
    const { urls } = verifierNameFilter()
    for (const scheme of ['http', 'https', 'ws', 'wss']) for (const suffix of ['eth', 'orivon']) {
      expect(urls).toContain(`${scheme}://*.${suffix}/*`)
      expect(urls).toContain(`${scheme}://*.${suffix}./*`)
    }
    expect(urls.every((pattern) => /^wss?:\/\/|^https?:\/\//.test(pattern))).toBe(true)
  })
})

describe('whether a proxy would carry a request', () => {
  it('does for every answer but exactly DIRECT', () => {
    expect(proxyWouldCarry('DIRECT')).toBe(false)
    expect(proxyWouldCarry(' DIRECT ')).toBe(false)
    for (const answer of ['PROXY 127.0.0.1:3128', 'SOCKS5 127.0.0.1:9050', 'HTTPS proxy.test:443', 'PROXY p:1; DIRECT', 'DIRECT; PROXY p:1', '', 'direct']) expect(proxyWouldCarry(answer), answer).toBe(true)
  })
})

describe('the guard of a session', () => {
  const quiet = (): void => {}

  it('lets a request go when the session\'s proxy is DIRECT', async () => {
    const note = vi.fn()
    const handler = verifierNameGuard({ followsSystem: () => true, ask: async () => 'DIRECT', note })
    expect(await handler({ url: 'https://name.eth/', resourceType: 'mainFrame', webContentsId: 3 }, {})).toEqual({})
    expect(note).not.toHaveBeenCalled()
  })

  it('cancels a request when the proxy would carry it, and remembers a main-frame load so the sheet can say why', async () => {
    const note = vi.fn()
    const handler = verifierNameGuard({ followsSystem: () => true, ask: async () => 'PROXY 127.0.0.1:3128', note })
    expect(await handler({ url: 'https://refused.eth/', resourceType: 'mainFrame', webContentsId: 3 }, {})).toEqual({ cancel: true })
    expect(proxyRefusals.claims(3, 'https://refused.eth/')).toBe(true)
    expect(proxyRefusals.claims(3, 'https://refused.eth/')).toBe(false)
    expect(note).toHaveBeenCalledExactlyOnceWith('https://refused.eth/', 'PROXY 127.0.0.1:3128')
  })

  it('cancels a plain http page the same way', async () => {
    const handler = verifierNameGuard({ followsSystem: () => true, ask: async () => 'PROXY 127.0.0.1:3128', note: quiet })
    expect(await handler({ url: 'http://plain-refused.eth/', resourceType: 'mainFrame', webContentsId: 4 }, {})).toEqual({ cancel: true })
    expect(proxyRefusals.claims(4, 'http://plain-refused.eth/')).toBe(true)
  })

  it('cancels a subresource without marking a sheet for it', async () => {
    const handler = verifierNameGuard({ followsSystem: () => true, ask: async () => 'PROXY 127.0.0.1:3128', note: quiet })
    expect(await handler({ url: 'https://sub.eth/a.js', resourceType: 'script', webContentsId: 5 }, {})).toEqual({ cancel: true })
    expect(proxyRefusals.claims(5, 'https://sub.eth/a.js')).toBe(false)
  })

  it('cancels when the proxy cannot be asked: a request is not sent on a guess', async () => {
    const note = vi.fn()
    const handler = verifierNameGuard({ followsSystem: () => true, ask: async () => { throw new Error('gone') }, note })
    expect(await handler({ url: 'https://failed.eth/', resourceType: 'mainFrame', webContentsId: 6 }, {})).toEqual({ cancel: true })
    expect(note).toHaveBeenCalledExactlyOnceWith('https://failed.eth/', undefined)
  })

  it('leaves a session that is pointed at a tunnel or held shut alone, and does not ask it', async () => {
    const ask = vi.fn(async () => 'PROXY 127.0.0.1:3128')
    const note = vi.fn()
    const handler = verifierNameGuard({ followsSystem: () => false, ask, note })
    const current = { redirectURL: 'https://elsewhere.test/' }
    expect(await handler({ url: 'https://tunnelled.eth/', resourceType: 'mainFrame', webContentsId: 7 }, current)).toBe(current)
    expect(ask).not.toHaveBeenCalled()
    expect(note).not.toHaveBeenCalled()
  })
})

describe('the line in the log', () => {
  it('says what was refused without the name or the proxy\'s address', () => {
    const line = createRefusalNotes()('https://secret-name.eth/', 'PROXY 10.1.2.3:3128')
    expect(line).toBe('[route] refused a request for a .eth name: its proxy (PROXY) would have carried it, and so seen the name')
    expect(line).not.toMatch(/secret-name|10\.1\.2\.3/)
  })

  it('says so when the proxy could not be asked', () => {
    expect(createRefusalNotes()('https://a.eth/', undefined)).toContain('its proxy could not be asked')
  })

  it('writes one line a minute and counts what it left out', () => {
    let at = 0
    const note = createRefusalNotes({ now: () => at })
    expect(note('https://a.eth/', 'PROXY p:1')).toBeDefined()
    at = 10_000
    expect(note('https://a.eth/', 'PROXY p:1')).toBeUndefined()
    expect(note('https://b.eth/', 'PROXY p:1')).toBeUndefined()
    at = 60_000
    expect(note('https://c.orivon/', 'SOCKS5 p:1')).toBe('[route] refused a request for a .orivon name: its proxy (SOCKS5) would have carried it, and so seen the name; 2 more since the last line')
    at = 130_000
    expect(note('https://d.eth/', 'PROXY p:1')).not.toContain('more since')
  })

  it('goes to the console, where a bug report reads the log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    noteRefusal('https://logged.eth/', 'PROXY p:1')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('[route] refused a request for a .eth name')
  })
})

describe('a request Orivon makes itself', () => {
  it('is refused with the words of the sheet when the session\'s proxy would carry it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = { resolveProxy: vi.fn(async () => 'PROXY p:1') }
    await expect(refuseWhenProxySees(session, 'https://app.eth/index.html')).rejects.toThrow(PROXY_WOULD_SEE_NAME)
  })

  it('goes on when the session sends the name to the verifier, and asks nothing for any other host', async () => {
    const direct = { resolveProxy: vi.fn(async () => 'DIRECT') }
    await expect(refuseWhenProxySees(direct, 'https://app.eth/')).resolves.toBeUndefined()
    const other = { resolveProxy: vi.fn(async () => 'PROXY p:1') }
    await expect(refuseWhenProxySees(other, 'https://example.com/')).resolves.toBeUndefined()
    expect(other.resolveProxy).not.toHaveBeenCalled()
  })

  it('is refused when the session cannot say, and asks again once its proxy was set', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = { resolveProxy: vi.fn<(url: string) => Promise<string>>().mockRejectedValueOnce(new Error('gone')).mockResolvedValue('DIRECT') }
    await expect(refuseWhenProxySees(session, 'https://reset.eth/')).rejects.toThrow(PROXY_WOULD_SEE_NAME)
    await expect(refuseWhenProxySees(session, 'https://reset.eth/')).resolves.toBeUndefined()
    session.resolveProxy.mockResolvedValue('PROXY p:1')
    await expect(refuseWhenProxySees(session, 'https://reset.eth/')).resolves.toBeUndefined()
    noteProxySet(session)
    await expect(refuseWhenProxySees(session, 'https://reset.eth/')).rejects.toThrow(PROXY_WOULD_SEE_NAME)
  })

  it('wraps a fetch so that it is not made when the proxy would carry the name', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const send = vi.fn(async () => new Response('ok'))
    const proxied = refusingProxiedNames({ resolveProxy: async () => 'PROXY p:1' }, send)
    await expect(proxied('https://wrapped.eth/')).rejects.toThrow(PROXY_WOULD_SEE_NAME)
    expect(send).not.toHaveBeenCalled()
    await expect(refusingProxiedNames({ resolveProxy: async () => 'DIRECT' }, send)('https://wrapped.eth/')).resolves.toBeInstanceOf(Response)
    expect(send).toHaveBeenCalledTimes(1)
  })
})
