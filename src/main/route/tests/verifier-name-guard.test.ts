import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadRefusals } from '../load-refusals.js'
import { trackProxySet } from '../proxy-answers.js'
import {
  createRefusalNotes, guardOfSession, namesVerifierHost, noteRefusal, PLAIN_NAME_REFUSED, PROXY_NOT_KNOWN, PROXY_WOULD_SEE_NAME, proxyWouldCarry,
  refuseWhenProxySees, refusesPlain, refusingProxiedNames, verifierNameFilter, verifierNameGuard
} from '../verifier-name-guard.js'
import type { NameRefusal } from '../verifier-name-guard.js'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

const none = (): boolean => false

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

describe('which requests are never sent whatever the proxy says', () => {
  it('are those over plain http and ws, unless the host is allowed', () => {
    for (const url of ['http://name.eth/', 'ws://name.eth/socket', 'http://NAME.eth./x']) expect(refusesPlain(url, none), url).toBe(true)
    for (const url of ['https://name.eth/', 'wss://name.eth/socket', 'not a url']) expect(refusesPlain(url, none), url).toBe(false)
    expect(refusesPlain('http://dev.eth:8080/', (host) => host === 'dev.eth')).toBe(false)
    expect(refusesPlain('http://dev.eth./', (host) => host === 'dev.eth')).toBe(false)
    expect(refusesPlain('http://other.eth/', (host) => host === 'dev.eth')).toBe(true)
  })
})

describe('the guard of a session', () => {
  const quiet = (): void => {}
  const details = (url: string, resourceType = 'mainFrame', webContentsId = 3): { url: string, resourceType: string, webContentsId: number } => ({ url, resourceType, webContentsId })

  it('lets a request go when the session\'s proxy is DIRECT', async () => {
    const note = vi.fn()
    const handler = verifierNameGuard({ followsSystem: () => true, ask: async () => 'DIRECT', allowsPlain: none, note })
    expect(await handler(details('https://name.eth/'), {})).toEqual({})
    expect(note).not.toHaveBeenCalled()
  })

  it('cancels a request when the proxy would carry it, and remembers a main-frame load so the sheet can say why', async () => {
    const note = vi.fn()
    const handler = verifierNameGuard({ followsSystem: () => true, ask: async () => 'PROXY 127.0.0.1:3128', allowsPlain: none, note })
    expect(await handler(details('https://refused.eth/'), {})).toEqual({ cancel: true })
    expect(loadRefusals.claims(3, 'https://refused.eth/')).toBe('would-see')
    expect(loadRefusals.claims(3, 'https://refused.eth/')).toBeUndefined()
    expect(note).toHaveBeenCalledExactlyOnceWith('https://refused.eth/', { kind: 'would-see', answer: 'PROXY 127.0.0.1:3128' })
  })

  it('cancels a subresource without marking a sheet for it', async () => {
    const handler = verifierNameGuard({ followsSystem: () => true, ask: async () => 'PROXY 127.0.0.1:3128', allowsPlain: none, note: quiet })
    expect(await handler(details('https://sub.eth/a.js', 'script', 5), {})).toEqual({ cancel: true })
    expect(loadRefusals.claims(5, 'https://sub.eth/a.js')).toBeUndefined()
  })

  it('cancels a plain http or ws request whatever the proxy answers, and never asks it', async () => {
    const ask = vi.fn(async () => 'DIRECT')
    const note = vi.fn()
    const handler = verifierNameGuard({ followsSystem: () => true, ask, allowsPlain: none, note })
    expect(await handler(details('http://plain-refused.eth/', 'mainFrame', 4), {})).toEqual({ cancel: true })
    expect(loadRefusals.claims(4, 'http://plain-refused.eth/')).toBe('plain')
    expect(await handler(details('ws://plain-refused.eth/socket', 'webSocket', 4), {})).toEqual({ cancel: true })
    expect(ask).not.toHaveBeenCalled()
    expect(note).toHaveBeenCalledWith('http://plain-refused.eth/', { kind: 'plain' })
  })

  it('lets a developer name be asked for over plain http, and asks the proxy about it like any other', async () => {
    const direct = verifierNameGuard({ followsSystem: () => true, ask: async () => 'DIRECT', allowsPlain: (host) => host === 'dev.eth', note: quiet })
    expect(await direct(details('http://dev.eth:8080/'), {})).toEqual({})
    const proxied = verifierNameGuard({ followsSystem: () => true, ask: async () => 'PROXY p:1', allowsPlain: (host) => host === 'dev.eth', note: quiet })
    expect(await proxied(details('http://dev.eth:8080/', 'mainFrame', 9), {})).toEqual({ cancel: true })
    expect(loadRefusals.claims(9, 'http://dev.eth:8080/')).toBe('would-see')
  })

  it('cancels when the proxy cannot be asked, and says it could not tell rather than that the proxy would see the name', async () => {
    const note = vi.fn()
    const handler = verifierNameGuard({ followsSystem: () => true, ask: async () => { throw new Error('gone') }, allowsPlain: none, note })
    expect(await handler(details('https://failed.eth/', 'mainFrame', 6), {})).toEqual({ cancel: true })
    expect(loadRefusals.claims(6, 'https://failed.eth/')).toBe('unsure')
    expect(note).toHaveBeenCalledExactlyOnceWith('https://failed.eth/', { kind: 'unsure' })
  })

  it('leaves a session that is pointed at a tunnel or held shut alone, and does not ask it', async () => {
    const ask = vi.fn(async () => 'PROXY 127.0.0.1:3128')
    const note = vi.fn()
    const handler = verifierNameGuard({ followsSystem: () => false, ask, allowsPlain: none, note })
    const current = { redirectURL: 'https://elsewhere.test/' }
    expect(await handler(details('https://tunnelled.eth/', 'mainFrame', 7), current)).toBe(current)
    expect(await handler(details('http://tunnelled.eth/', 'mainFrame', 7), current)).toBe(current)
    expect(ask).not.toHaveBeenCalled()
    expect(note).not.toHaveBeenCalled()
  })

  it('cancels whatever goes wrong while it decides, so a failure never lets a request out', async () => {
    const failures: Array<[string, Partial<Parameters<typeof verifierNameGuard>[0]>]> = [
      ['the session cannot say whether it follows the system', { followsSystem: () => { throw new Error('no controller') } }],
      ['the wait for a change of its proxy fails', { settled: async () => { throw new Error('still being set') } }],
      ['the epoch cannot be read', { epoch: () => { throw new Error('no epoch') } }],
      ['the question throws before it returns a promise', { ask: () => { throw new Error('sync') } }]
    ]
    for (const [label, broken] of failures) {
      const handler = verifierNameGuard({ followsSystem: () => true, ask: async () => 'DIRECT', allowsPlain: none, note: quiet, ...broken })
      expect(await handler(details('https://broken.eth/'), {}), label).toEqual({ cancel: true })
    }
  })

  it('cancels even when saying why fails', async () => {
    const handler = verifierNameGuard({ followsSystem: () => true, ask: async () => 'PROXY p:1', allowsPlain: none, note: () => { throw new Error('the log is gone') } })
    expect(await handler(details('https://silent.eth/', 'mainFrame', 12), {})).toEqual({ cancel: true })
  })

  it('waits for a change of the session\'s proxy to end before it asks, and judges the session as it is then', async () => {
    let onTunnel = true
    let end: () => void = () => {}
    const ask = vi.fn(async () => 'PROXY p:1')
    const handler = verifierNameGuard({ followsSystem: () => !onTunnel, ask, allowsPlain: none, note: quiet, settled: async () => { await new Promise<void>((done) => { end = done }) } })
    const decided = handler(details('https://moving.eth/'), {})
    await Promise.resolve()
    expect(ask).not.toHaveBeenCalled()
    onTunnel = false
    end()
    expect(await decided).toEqual({ cancel: true })
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('lets a request go that waited for a session to settle on a tunnel', async () => {
    let onTunnel = false
    const ask = vi.fn(async () => 'PROXY p:1')
    let end: () => void = () => {}
    const handler = verifierNameGuard({ followsSystem: () => !onTunnel, ask, allowsPlain: none, note: quiet, settled: async () => { await new Promise<void>((done) => { end = done }) } })
    const decided = handler(details('https://entering.eth/'), {})
    await Promise.resolve()
    onTunnel = true
    end()
    expect(await decided).toEqual({})
    expect(ask).not.toHaveBeenCalled()
  })

  it('asks again when the session\'s proxy was set while it asked, and cancels when that keeps happening', async () => {
    let epoch = 0
    const answers = vi.fn<() => Promise<string>>().mockImplementationOnce(async () => { epoch += 1; return 'DIRECT' }).mockResolvedValue('PROXY p:1')
    const settled = vi.fn(async () => {})
    const handler = verifierNameGuard({ followsSystem: () => true, ask: answers, epoch: () => epoch, settled, allowsPlain: none, note: quiet })
    expect(await handler(details('https://racing.eth/'), {})).toEqual({ cancel: true })
    expect(answers).toHaveBeenCalledTimes(2)
    expect(settled).toHaveBeenCalledTimes(2)

    const never = vi.fn(async () => { epoch += 1; return 'DIRECT' })
    const unsettled = verifierNameGuard({ followsSystem: () => true, ask: never, epoch: () => epoch, allowsPlain: none, note: quiet })
    expect(await unsettled(details('https://racing.eth/', 'mainFrame', 13), {})).toEqual({ cancel: true })
    expect(loadRefusals.claims(13, 'https://racing.eth/')).toBe('unsure')
    expect(never.mock.calls.length).toBeGreaterThan(1)
  })
})

describe('the guard of a session whose proxy a controller sets', () => {
  const resolver = (answer: string): { resolveProxy: ReturnType<typeof vi.fn<(url: string) => Promise<string>>> } => ({ resolveProxy: vi.fn(async () => answer) })

  it('follows the system while the controller says it is on no tunnel, and not while it says it is', () => {
    const session = resolver('DIRECT')
    expect(guardOfSession(session, () => undefined).followsSystem()).toBe(true)
    expect(guardOfSession(session, () => 'socks5').followsSystem()).toBe(false)
    expect(guardOfSession(session, () => 'held').followsSystem()).toBe(false)
  })

  it('follows the system whatever the controller says while its proxy is being set, and after a change the controller gave up on', async () => {
    vi.useFakeTimers()
    const session = resolver('PROXY p:1')
    const onTunnel = guardOfSession(session, () => 'nym')
    let end: () => void = () => {}
    const change = trackProxySet(session, async () => { await new Promise<void>((done) => { end = done }) }, 1_000)
    expect(onTunnel.followsSystem(), 'under way').toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)
    end()
    await change
    expect(onTunnel.followsSystem(), 'ended, but later than it was waited for').toBe(true)
    await trackProxySet(session, async () => {}, 1_000)
    expect(onTunnel.followsSystem(), 'a quick change since').toBe(false)
  })
})

describe('the line in the log', () => {
  const seen: NameRefusal = { kind: 'would-see', answer: 'PROXY 10.1.2.3:3128' }

  it('says what was refused without the name or the proxy\'s address', () => {
    const line = createRefusalNotes()('https://secret-name.eth/', seen)
    expect(line).toBe('[route] refused a request for a .eth name: its proxy (PROXY) would have carried it, and so seen the name')
    expect(line).not.toMatch(/secret-name|10\.1\.2\.3/)
  })

  it('says so when it could not be told, without saying the proxy would see the name', () => {
    const line = createRefusalNotes()('https://a.eth/', { kind: 'unsure' })
    expect(line).toBe('[route] refused a request for a .eth name: it could not be told whether its proxy would carry it')
    expect(line).not.toContain('seen the name')
  })

  it('says a plain request is refused whatever the proxy is', () => {
    expect(createRefusalNotes()('http://a.eth/', { kind: 'plain' })).toBe('[route] refused a plain request for a .eth name: these names open over https only')
  })

  it('writes one line a minute of each kind and counts what it left out', () => {
    let at = 0
    const note = createRefusalNotes({ now: () => at })
    expect(note('https://a.eth/', { kind: 'would-see', answer: 'PROXY p:1' })).toBeDefined()
    at = 10_000
    expect(note('https://a.eth/', { kind: 'would-see', answer: 'PROXY p:1' })).toBeUndefined()
    expect(note('https://b.eth/', { kind: 'would-see', answer: 'PROXY p:1' })).toBeUndefined()
    expect(note('https://b.eth/', { kind: 'unsure' }), 'another kind has its own line').toBeDefined()
    at = 60_000
    expect(note('https://c.orivon/', { kind: 'would-see', answer: 'SOCKS5 p:1' })).toBe('[route] refused a request for a .orivon name: its proxy (SOCKS5) would have carried it, and so seen the name; 2 more since the last line')
    at = 130_000
    expect(note('https://d.eth/', { kind: 'would-see', answer: 'PROXY p:1' })).not.toContain('more since')
  })

  it('goes to the console, where a bug report reads the log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    noteRefusal('https://logged.eth/', { kind: 'would-see', answer: 'PROXY p:1' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('[route] refused a request for a .eth name')
  })
})

describe('a request Orivon makes itself', () => {
  it('is refused with the words of the sheet when the session\'s proxy would carry it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = { resolveProxy: vi.fn(async () => 'PROXY p:1') }
    await expect(refuseWhenProxySees(session, 'https://app.eth/index.html', none)).rejects.toThrow(PROXY_WOULD_SEE_NAME)
  })

  it('goes on when the session sends the name to the verifier, and asks nothing for any other host', async () => {
    const direct = { resolveProxy: vi.fn(async () => 'DIRECT') }
    await expect(refuseWhenProxySees(direct, 'https://app.eth/', none)).resolves.toBeUndefined()
    const other = { resolveProxy: vi.fn(async () => 'PROXY p:1') }
    await expect(refuseWhenProxySees(other, 'https://example.com/', none)).resolves.toBeUndefined()
    expect(other.resolveProxy).not.toHaveBeenCalled()
  })

  it('is refused when the session cannot say, with words that say so, and asks again next time', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = { resolveProxy: vi.fn<(url: string) => Promise<string>>().mockRejectedValueOnce(new Error('gone')).mockResolvedValue('DIRECT') }
    await expect(refuseWhenProxySees(session, 'https://reset.eth/', none)).rejects.toThrow(PROXY_NOT_KNOWN)
    await expect(refuseWhenProxySees(session, 'https://reset.eth/', none)).resolves.toBeUndefined()
    session.resolveProxy.mockResolvedValue('PROXY p:1')
    await expect(refuseWhenProxySees(session, 'https://reset.eth/', none)).rejects.toThrow(PROXY_WOULD_SEE_NAME)
  })

  it('is refused over plain http without asking, unless the host is a developer name', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = { resolveProxy: vi.fn(async () => 'DIRECT') }
    await expect(refuseWhenProxySees(session, 'http://plain.eth/', none)).rejects.toThrow(PLAIN_NAME_REFUSED)
    expect(session.resolveProxy).not.toHaveBeenCalled()
    await expect(refuseWhenProxySees(session, 'http://dev.eth:8080/', (host) => host === 'dev.eth')).resolves.toBeUndefined()
  })

  it('waits for a change of the session\'s proxy to end, and is refused when it does not end', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = { resolveProxy: vi.fn(async () => 'DIRECT') }
    let end: () => void = () => {}
    const change = trackProxySet(session, async () => { await new Promise<void>((done) => { end = done }) })
    const refused = expect(refuseWhenProxySees(session, 'https://waits.eth/', none)).rejects.toThrow(PROXY_NOT_KNOWN)
    await vi.advanceTimersByTimeAsync(10_000)
    await refused
    expect(session.resolveProxy).not.toHaveBeenCalled()
    end()
    await change
    await expect(refuseWhenProxySees(session, 'https://waits.eth/', none)).resolves.toBeUndefined()
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
