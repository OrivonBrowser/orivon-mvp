import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebRequestHandlerHandle, WebRequestOwner } from '../../sessions/web-request-owner.js'
import type { ApiEvent } from '../api/api-types.js'
import { BLOCKING_REPLY_TIMEOUT_MS, WEB_REQUEST_ORDER, createWebRequestDispatcher } from '../web-request-dispatch.js'

const ME = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
const FILTER = { urls: ['<all_urls>'] }

type Run = (...args: any[]) => any

/** An owner that records what the dispatcher registers, and how often it let go. */
function fakeOwner (): { owner: WebRequestOwner, runs: Map<string, Run>, removed: string[], orders: Map<string, number> } {
  const runs = new Map<string, Run>()
  const removed: string[] = []
  const orders = new Map<string, number>()
  const blocking = (name: string) => (order: number, _filter: unknown, _matches: unknown, run: Run): WebRequestHandlerHandle => {
    runs.set(name, run)
    orders.set(name, order)
    return { remove: () => { runs.delete(name); removed.push(name) } }
  }
  const observer = (name: string) => (_filter: unknown, _matches: unknown, run: Run): WebRequestHandlerHandle => {
    runs.set(name, run)
    return { remove: () => { runs.delete(name); removed.push(name) } }
  }
  const owner = {
    onBeforeRequest: blocking('onBeforeRequest'),
    onBeforeSendHeaders: blocking('onBeforeSendHeaders'),
    onHeadersReceived: blocking('onHeadersReceived'),
    onSendHeaders: observer('onSendHeaders'),
    onResponseStarted: observer('onResponseStarted'),
    onBeforeRedirect: observer('onBeforeRedirect'),
    onCompleted: observer('onCompleted'),
    onErrorOccurred: observer('onErrorOccurred')
  } as unknown as WebRequestOwner
  return { owner, runs, removed, orders }
}

interface FakeHost {
  send: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
  getURL: () => string
  once: (event: string, run: (...args: unknown[]) => void) => void
  on: (event: string, run: (...args: unknown[]) => void) => void
  emit: (event: string, ...args: unknown[]) => void
  destroy: () => void
}

/** A page of extension `ownerId`, as WebContents shows it to the dispatcher. */
function fakeHost (ownerId = ME): FakeHost {
  let destroyed = false
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  const add = (event: string, run: (...args: unknown[]) => void): void => { handlers.set(event, [...(handlers.get(event) ?? []), run]) }
  const emit = (event: string, ...args: unknown[]): void => { for (const run of handlers.get(event) ?? []) run({}, ...args) }
  return {
    send: vi.fn(),
    isDestroyed: () => destroyed,
    getURL: () => `chrome-extension://${ownerId}/background.html`,
    once: add,
    on: add,
    emit,
    destroy: () => { destroyed = true; emit('destroyed') }
  }
}

const apiEvent = (host: FakeHost, extensionId = ME, manifest: Record<string, unknown> = { manifest_version: 2 }): ApiEvent =>
  ({ type: 'frame', sender: host as unknown as ApiEvent['sender'], extension: { id: extensionId, manifest } })

interface Setup {
  dispatcher: ReturnType<typeof createWebRequestDispatcher>
  fake: ReturnType<typeof fakeOwner>
  access: ReturnType<typeof vi.fn>
  held: ReturnType<typeof vi.fn>
  hostPermissionsOf: ReturnType<typeof vi.fn>
}

function setup (overrides: {
  access?: (id: string, url: string) => boolean
  held?: (id: string, permission: string) => boolean
  isAppOrigin?: (url: string) => boolean
  pageUrl?: string
  timeoutMs?: number
} = {}): Setup {
  const fake = fakeOwner()
  const access = vi.fn((id: string, _hostPermissions: unknown, url: string) => overrides.access === undefined ? true : overrides.access(id, url))
  const hostPermissionsOf = vi.fn(() => ['<all_urls>'])
  const held = vi.fn((id: string, permission: string) => overrides.held === undefined ? true : overrides.held(id, permission))
  const dispatcher = createWebRequestDispatcher({
    owner: fake.owner,
    isTab: (id) => id === 5,
    hostPermissionsOf,
    hostAccess: access,
    isAppOrigin: overrides.isAppOrigin ?? (() => false),
    pageUrlOf: () => overrides.pageUrl,
    held,
    installedAt: (id) => id === ME ? 10 : 20,
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs })
  })
  return { dispatcher, fake, access, held, hostPermissionsOf }
}

const top = { parent: null, frameTreeNodeId: 1, origin: 'https://site.example' }
const electronRequest = (overrides: Record<string, unknown> = {}): any => ({
  id: 1, url: 'https://cdn.example/a.js', method: 'GET', resourceType: 'script', webContentsId: 5, frame: top, timestamp: 1, ...overrides
})

describe('addListener', () => {
  it('registers and removes the owner handler with the first and last listener of an event', () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onCompleted', 1, FILTER, [])
    dispatcher.addListener(apiEvent(host), 'onCompleted', 2, FILTER, [])
    expect(fake.runs.has('onCompleted')).toBe(true)
    expect(dispatcher.registrationCount('onCompleted')).toBe(2)
    dispatcher.removeListener(apiEvent(host), 'onCompleted', 1)
    expect(fake.runs.has('onCompleted')).toBe(true)
    dispatcher.removeListener(apiEvent(host), 'onCompleted', 2)
    expect(fake.runs.has('onCompleted')).toBe(false)
    expect(fake.removed).toEqual(['onCompleted'])
  })

  it('registers one owner handler per event, blocking ones after declarativeNetRequest', () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onBeforeRequest', 1, FILTER, ['blocking'])
    dispatcher.addListener(apiEvent(host), 'onBeforeRequest', 2, FILTER, ['blocking'])
    expect([...fake.runs.keys()]).toEqual(['onBeforeRequest'])
    expect(fake.orders.get('onBeforeRequest')).toBe(WEB_REQUEST_ORDER)
    expect(WEB_REQUEST_ORDER).toBeGreaterThan(1000)
    expect(WEB_REQUEST_ORDER).toBeLessThan(Number.MAX_SAFE_INTEGER)
  })

  it('replaces a listener registered again under the same id', () => {
    const { dispatcher } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onCompleted', 1, FILTER, [])
    dispatcher.addListener(apiEvent(host), 'onCompleted', 1, FILTER, [])
    expect(dispatcher.registrationCount('onCompleted')).toBe(1)
  })

  it('refuses an unknown event, a bad listener id, a bad filter and a bad spec with a message', () => {
    const { dispatcher } = setup()
    const event = apiEvent(fakeHost())
    expect(() => { dispatcher.addListener(event, 'onNothing', 1, FILTER, []) }).toThrow(/not an event/)
    expect(() => { dispatcher.addListener(event, 'onCompleted', 'x', FILTER, []) }).toThrow(/listener id/)
    expect(() => { dispatcher.addListener(event, 'onCompleted', 1, { urls: [] }, []) }).toThrow(/urls/)
    expect(() => { dispatcher.addListener(event, 'onCompleted', 1, FILTER, ['blocking']) }).toThrow(/Value must be one of/)
  })

  it('refuses a blocking listener without webRequestBlocking, with Chrome\'s message', () => {
    const { dispatcher, held } = setup({ held: (_id, permission) => permission !== 'webRequestBlocking' })
    expect(() => { dispatcher.addListener(apiEvent(fakeHost()), 'onBeforeRequest', 1, FILTER, ['blocking']) })
      .toThrow('You do not have permission to use blocking webRequest listeners. Be sure to declare the webRequestBlocking permission in your manifest.')
    expect(held).toHaveBeenCalledWith(ME, 'webRequestBlocking')
    expect(dispatcher.registrationCount('onBeforeRequest')).toBe(0)
  })

  it('refuses a blocking listener from a manifest version 3 extension', () => {
    const { dispatcher } = setup()
    expect(() => { dispatcher.addListener(apiEvent(fakeHost(), ME, { manifest_version: 3 }), 'onBeforeRequest', 1, FILTER, ['blocking']) }).toThrow(/blocking/)
  })

  it('lets a manifest version 3 extension observe', () => {
    const { dispatcher } = setup()
    dispatcher.addListener(apiEvent(fakeHost(), ME, { manifest_version: 3 }), 'onCompleted', 1, FILTER, [])
    expect(dispatcher.registrationCount('onCompleted')).toBe(1)
  })

  it('accepts onAuthRequired and never wires it', () => {
    const { dispatcher, fake } = setup()
    dispatcher.addListener(apiEvent(fakeHost()), 'onAuthRequired', 1, FILTER, ['blocking'])
    expect(fake.runs.size).toBe(0)
    expect(dispatcher.registrationCount('onAuthRequired')).toBe(0)
  })

  it('needs a sender', () => {
    const { dispatcher } = setup()
    const event: ApiEvent = { type: 'frame', sender: undefined, extension: { id: ME, manifest: {} } }
    expect(() => { dispatcher.addListener(event, 'onCompleted', 1, FILTER, []) }).toThrow()
  })

  it('drops a host\'s listeners when the host is destroyed', () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onCompleted', 1, FILTER, [])
    host.destroy()
    expect(dispatcher.registrationCount('onCompleted')).toBe(0)
    expect(fake.runs.has('onCompleted')).toBe(false)
  })

  it('drops every listener of an extension that unloads', () => {
    const { dispatcher } = setup()
    const host = fakeHost()
    const other = fakeHost(OTHER)
    dispatcher.addListener(apiEvent(host), 'onCompleted', 1, FILTER, [])
    dispatcher.addListener(apiEvent(other, OTHER), 'onCompleted', 1, FILTER, [])
    dispatcher.dropExtension(ME)
    expect(dispatcher.registrationCount('onCompleted')).toBe(1)
  })

  it('removes only the listener the caller registered', () => {
    const { dispatcher } = setup()
    const host = fakeHost()
    const other = fakeHost(OTHER)
    dispatcher.addListener(apiEvent(host), 'onCompleted', 1, FILTER, [])
    dispatcher.removeListener(apiEvent(other, OTHER), 'onCompleted', 1)
    dispatcher.removeListener(apiEvent(host), 'onCompleted', 1)
    expect(dispatcher.registrationCount('onCompleted')).toBe(0)
  })
})

describe('observer events', () => {
  it('send the details to a matching listener and no reply is asked', () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onCompleted', 4, FILTER, [])
    fake.runs.get('onCompleted')?.(electronRequest({ statusCode: 200, statusLine: 'HTTP/1.1 200 OK', fromCache: false }))
    expect(host.send).toHaveBeenCalledTimes(1)
    const [channel, listenerId, dispatchId, eventName, details] = host.send.mock.calls[0] as [string, number, number, string, Record<string, unknown>]
    expect([channel, listenerId, dispatchId, eventName]).toEqual(['crx-webRequest.dispatch', 4, 0, 'onCompleted'])
    expect(details).toMatchObject({ requestId: '1', url: 'https://cdn.example/a.js', type: 'script', tabId: 5, statusCode: 200, initiator: 'https://site.example' })
  })

  it('report a page that is not a tab as tab -1', () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onCompleted', 1, FILTER, [])
    fake.runs.get('onCompleted')?.(electronRequest({ webContentsId: 77 }))
    expect((host.send.mock.calls[0] as unknown[])[4]).toMatchObject({ tabId: -1 })
  })

  it('skip a listener whose filter does not cover the request', () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onCompleted', 1, { urls: ['https://*.other.example/*'] }, [])
    dispatcher.addListener(apiEvent(host), 'onCompleted', 2, { urls: ['<all_urls>'], types: ['image'] }, [])
    dispatcher.addListener(apiEvent(host), 'onCompleted', 3, { urls: ['<all_urls>'], tabId: 9 }, [])
    fake.runs.get('onCompleted')?.(electronRequest())
    expect(host.send).not.toHaveBeenCalled()
  })

  it('skip an extension that has no host access to the request, and one for a request with no page', () => {
    const { dispatcher, fake } = setup({ access: (id) => id !== OTHER })
    const mine = fakeHost()
    const theirs = fakeHost(OTHER)
    dispatcher.addListener(apiEvent(mine), 'onCompleted', 1, FILTER, [])
    dispatcher.addListener(apiEvent(theirs, OTHER), 'onCompleted', 1, FILTER, [])
    fake.runs.get('onCompleted')?.(electronRequest())
    expect(mine.send).toHaveBeenCalledTimes(1)
    expect(theirs.send).not.toHaveBeenCalled()
    fake.runs.get('onCompleted')?.(electronRequest({ webContentsId: undefined }))
    expect(mine.send).toHaveBeenCalledTimes(1)
  })

  it('carry headers only to the listener that asked for them', () => {
    const { dispatcher, fake } = setup()
    const asked = fakeHost()
    const quiet = fakeHost()
    dispatcher.addListener(apiEvent(asked), 'onSendHeaders', 1, FILTER, ['requestHeaders'])
    dispatcher.addListener(apiEvent(quiet), 'onSendHeaders', 1, FILTER, [])
    fake.runs.get('onSendHeaders')?.(electronRequest({ requestHeaders: { Accept: '*/*' } }))
    expect((asked.send.mock.calls[0] as unknown[])[4]).toMatchObject({ requestHeaders: [{ name: 'Accept', value: '*/*' }] })
    expect((quiet.send.mock.calls[0] as unknown[])[4]).not.toHaveProperty('requestHeaders')
  })

  it('give an error to onErrorOccurred and the redirect to onBeforeRedirect', () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onErrorOccurred', 1, FILTER, [])
    dispatcher.addListener(apiEvent(host), 'onBeforeRedirect', 2, FILTER, [])
    fake.runs.get('onErrorOccurred')?.(electronRequest({ error: 'net::ERR_BLOCKED_BY_CLIENT' }))
    fake.runs.get('onBeforeRedirect')?.(electronRequest({ redirectURL: 'https://next.example/', statusCode: 302 }))
    expect((host.send.mock.calls[0] as unknown[])[4]).toMatchObject({ error: 'net::ERR_BLOCKED_BY_CLIENT' })
    expect((host.send.mock.calls[1] as unknown[])[4]).toMatchObject({ redirectUrl: 'https://next.example/', statusCode: 302 })
  })

  it('never reach a destroyed host', () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onCompleted', 1, FILTER, [])
    host.destroy()
    expect(() => fake.runs.get('onCompleted')?.(electronRequest())).not.toThrow()
    expect(host.send).not.toHaveBeenCalled()
  })

  it('survive a host whose send throws', () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      host.send.mockImplementation(() => { throw new Error('gone') })
      dispatcher.addListener(apiEvent(host), 'onCompleted', 1, FILTER, [])
      expect(() => fake.runs.get('onCompleted')?.(electronRequest())).not.toThrow()
    } finally { spy.mockRestore() }
  })
})

describe('blocking events', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const dispatchIdOf = (host: FakeHost, call = 0): number => (host.send.mock.calls[call] as unknown[])[2] as number

  it('cancel a request a listener cancels, and hand back what it had when nobody has an opinion', async () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onBeforeRequest', 1, FILTER, ['blocking'])
    const soFar = {}
    const pending = fake.runs.get('onBeforeRequest')?.(electronRequest(), soFar)
    expect(dispatchIdOf(host)).toBeGreaterThan(0)
    dispatcher.reply(apiEvent(host), dispatchIdOf(host), { cancel: true })
    await expect(pending).resolves.toEqual({ cancel: true })

    const second = fake.runs.get('onBeforeRequest')?.(electronRequest(), soFar)
    dispatcher.reply(apiEvent(host), dispatchIdOf(host, 1), null)
    expect(await second).toBe(soFar)
  })

  it('answers at once, without a send, when no listener may see the request', async () => {
    const { dispatcher, fake } = setup({ access: () => false })
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onBeforeRequest', 1, FILTER, ['blocking'])
    const soFar = {}
    expect(await fake.runs.get('onBeforeRequest')?.(electronRequest(), soFar)).toBe(soFar)
    expect(host.send).not.toHaveBeenCalled()
  })

  it('redirects to the listener\'s own extension page and drops a scheme it may not use', async () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onBeforeRequest', 1, FILTER, ['blocking'])
    const own = fake.runs.get('onBeforeRequest')?.(electronRequest(), {})
    dispatcher.reply(apiEvent(host), dispatchIdOf(host), { redirectUrl: `chrome-extension://${ME}/web_accessible_resources/x.js` })
    await expect(own).resolves.toEqual({ redirectURL: `chrome-extension://${ME}/web_accessible_resources/x.js` })

    const bad = fake.runs.get('onBeforeRequest')?.(electronRequest(), {})
    dispatcher.reply(apiEvent(host), dispatchIdOf(host, 1), { redirectUrl: `chrome-extension://${OTHER}/x.js` })
    await expect(bad).resolves.toEqual({})
  })

  it('waits for every listener and lets the newest install\'s redirect win', async () => {
    const { dispatcher, fake } = setup()
    const mine = fakeHost()
    const theirs = fakeHost(OTHER)
    dispatcher.addListener(apiEvent(mine), 'onBeforeRequest', 1, FILTER, ['blocking'])
    dispatcher.addListener(apiEvent(theirs, OTHER), 'onBeforeRequest', 1, FILTER, ['blocking'])
    const pending = fake.runs.get('onBeforeRequest')?.(electronRequest(), {})
    dispatcher.reply(apiEvent(theirs, OTHER), dispatchIdOf(theirs), { redirectUrl: 'https://newer.example/' })
    dispatcher.reply(apiEvent(mine), dispatchIdOf(mine), { redirectUrl: 'https://older.example/' })
    await expect(pending).resolves.toEqual({ redirectURL: 'https://newer.example/' })
  })

  it('ignores a reply from another extension or another page, and an unknown or repeated one', async () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onBeforeRequest', 1, FILTER, ['blocking'])
    const pending = fake.runs.get('onBeforeRequest')?.(electronRequest(), {})
    const id = dispatchIdOf(host)
    dispatcher.reply(apiEvent(fakeHost()), id, { cancel: true })
    dispatcher.reply(apiEvent(host, OTHER), id, { cancel: true })
    dispatcher.reply(apiEvent(host), 'x', { cancel: true })
    dispatcher.reply(apiEvent(host), id + 100, { cancel: true })
    dispatcher.reply(apiEvent(host), id, null)
    dispatcher.reply(apiEvent(host), id, { cancel: true })
    await expect(pending).resolves.toEqual({})
  })

  it('takes a listener that does not answer in time to have no opinion, and says so once', async () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      dispatcher.addListener(apiEvent(host), 'onBeforeRequest', 1, FILTER, ['blocking'])
      const first = fake.runs.get('onBeforeRequest')?.(electronRequest(), {})
      await vi.advanceTimersByTimeAsync(BLOCKING_REPLY_TIMEOUT_MS)
      await expect(first).resolves.toEqual({})
      const second = fake.runs.get('onBeforeRequest')?.(electronRequest(), {})
      await vi.advanceTimersByTimeAsync(BLOCKING_REPLY_TIMEOUT_MS)
      await expect(second).resolves.toEqual({})
      expect(spy).toHaveBeenCalledTimes(1)
    } finally { spy.mockRestore() }
  })

  it('stops waiting when the host is destroyed', async () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onBeforeRequest', 1, FILTER, ['blocking'])
    const pending = fake.runs.get('onBeforeRequest')?.(electronRequest(), {})
    host.destroy()
    await expect(pending).resolves.toEqual({})
  })

  it('stops waiting when the extension unloads', async () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onBeforeRequest', 1, FILTER, ['blocking'])
    const pending = fake.runs.get('onBeforeRequest')?.(electronRequest(), {})
    dispatcher.dropExtension(ME)
    await expect(pending).resolves.toEqual({})
  })

  it('does not wait on a listener that did not ask to block', async () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onBeforeRequest', 1, FILTER, [])
    const soFar = {}
    expect(await fake.runs.get('onBeforeRequest')?.(electronRequest(), soFar)).toBe(soFar)
    expect(dispatchIdOf(host)).toBe(0)
  })

  it('merges header changes against the headers the earlier handlers left', async () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onBeforeSendHeaders', 1, FILTER, ['blocking', 'requestHeaders'])
    const pending = fake.runs.get('onBeforeSendHeaders')?.(electronRequest({ requestHeaders: { Accept: 'original' } }), { requestHeaders: { Accept: 'by-dnr' } })
    expect((host.send.mock.calls[0] as unknown[])[4]).toMatchObject({ requestHeaders: [{ name: 'Accept', value: 'by-dnr' }] })
    dispatcher.reply(apiEvent(host), dispatchIdOf(host), { requestHeaders: [{ name: 'Accept', value: 'by-dnr' }, { name: 'x-wr-test', value: '1' }] })
    await expect(pending).resolves.toEqual({ requestHeaders: { Accept: 'by-dnr', 'x-wr-test': '1' } })
  })

  it('answers the seed itself when a header listener changed nothing, so the owner replies with {}', async () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onBeforeSendHeaders', 1, FILTER, ['blocking', 'requestHeaders'])
    const seed = { requestHeaders: { Accept: '*/*' } }
    const pending = fake.runs.get('onBeforeSendHeaders')?.(electronRequest({ requestHeaders: { Accept: '*/*' } }), seed)
    dispatcher.reply(apiEvent(host), dispatchIdOf(host), { requestHeaders: [{ name: 'Accept', value: '*/*' }] })
    expect(await pending).toBe(seed)
  })

  it('adds response headers, as a blocker adds a policy', async () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onHeadersReceived', 1, FILTER, ['blocking', 'responseHeaders'])
    const pending = fake.runs.get('onHeadersReceived')?.(electronRequest({ statusCode: 200, statusLine: 'HTTP/1.1 200 OK' }), { responseHeaders: { 'content-type': ['text/html'] } })
    dispatcher.reply(apiEvent(host), dispatchIdOf(host), { responseHeaders: [{ name: 'content-type', value: 'text/html' }, { name: 'x-wr-response', value: '1' }] })
    await expect(pending).resolves.toEqual({ responseHeaders: { 'content-type': ['text/html'], 'x-wr-response': ['1'] } })
  })

  it('cancels at the header events too, keeping the headers it was given', async () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onHeadersReceived', 1, FILTER, ['blocking'])
    const pending = fake.runs.get('onHeadersReceived')?.(electronRequest(), { responseHeaders: { a: ['1'] } })
    dispatcher.reply(apiEvent(host), dispatchIdOf(host), { cancel: true })
    await expect(pending).resolves.toEqual({ cancel: true, responseHeaders: { a: ['1'] } })
  })
})

describe('a page that no longer holds its listeners', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('loses its registrations when its renderer process is gone, and the owner handler with the last one', () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onBeforeRequest', 1, FILTER, ['blocking'])
    dispatcher.addListener(apiEvent(host), 'onCompleted', 2, FILTER, [])
    host.emit('render-process-gone', { reason: 'crashed' })
    expect(dispatcher.registrationCount('onBeforeRequest')).toBe(0)
    expect(dispatcher.registrationCount('onCompleted')).toBe(0)
    expect(fake.runs.size).toBe(0)
  })

  it('loses them when it navigates to a page that is not its extension\'s', () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onBeforeRequest', 1, FILTER, ['blocking'])
    host.emit('did-navigate', 'https://example.com/')
    expect(dispatcher.registrationCount('onBeforeRequest')).toBe(0)
    expect(fake.runs.has('onBeforeRequest')).toBe(false)
  })

  it('keeps them when it navigates to another page of its own extension', () => {
    const { dispatcher } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onBeforeRequest', 1, FILTER, ['blocking'])
    host.emit('did-navigate', `chrome-extension://${ME}/options.html`)
    expect(dispatcher.registrationCount('onBeforeRequest')).toBe(1)
  })

  it('does not let another extension\'s page prefix pass for its own', () => {
    const { dispatcher } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onBeforeRequest', 1, FILTER, ['blocking'])
    host.emit('did-navigate', `chrome-extension://${ME}evil/page.html`)
    expect(dispatcher.registrationCount('onBeforeRequest')).toBe(0)
  })

  it('judges each registration by its own extension when a page moves between two extensions\' pages', () => {
    const { dispatcher } = setup()
    const host = fakeHost()
    let url = `chrome-extension://${ME}/page.html`
    host.getURL = () => url
    dispatcher.addListener(apiEvent(host), 'onBeforeRequest', 1, FILTER, ['blocking'])
    url = `chrome-extension://${OTHER}/page.html`
    host.emit('did-navigate', url)
    expect(dispatcher.registrationCount('onBeforeRequest')).toBe(0)
    dispatcher.addListener(apiEvent(host, OTHER), 'onBeforeRequest', 7, FILTER, ['blocking'])
    url = `chrome-extension://${ME}/page.html`
    host.emit('did-navigate', url)
    expect(dispatcher.registrationCount('onBeforeRequest')).toBe(0)
  })

  it('forgets a listener the page says it does not hold, and stops waiting at once', async () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onBeforeRequest', 1, FILTER, ['blocking'])
    dispatcher.addListener(apiEvent(host), 'onBeforeRequest', 2, FILTER, ['blocking'])
    const soFar = {}
    const pending = fake.runs.get('onBeforeRequest')?.(electronRequest(), soFar)
    const idOf = (call: number): number => (host.send.mock.calls[call] as unknown[])[2] as number
    const listenerOf = (call: number): number => (host.send.mock.calls[call] as unknown[])[1] as number
    const gone = listenerOf(0)
    dispatcher.reply(apiEvent(host), idOf(0), { gone: true })
    expect(dispatcher.registrationCount('onBeforeRequest')).toBe(1)
    dispatcher.reply(apiEvent(host), idOf(1), null)
    // No timer was advanced: the dispatch settled on the replies alone.
    expect(await pending).toBe(soFar)
    expect(gone).toBe(1)
  })

  it('reads only exactly { gone: true } as gone', async () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onBeforeRequest', 1, FILTER, ['blocking'])
    for (const response of [{ gone: true, cancel: true }, { gone: 'true' }, { gone: false }, [true]]) {
      const pending = fake.runs.get('onBeforeRequest')?.(electronRequest(), {})
      const id = (host.send.mock.calls.at(-1) as unknown[])[2] as number
      dispatcher.reply(apiEvent(host), id, response)
      await pending
    }
    expect(dispatcher.registrationCount('onBeforeRequest')).toBe(1)
  })

  it('tells the page which event it is dispatching', () => {
    const { dispatcher, fake } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onResponseStarted', 3, FILTER, [])
    fake.runs.get('onResponseStarted')?.(electronRequest())
    expect((host.send.mock.calls[0] as unknown[]).slice(0, 4)).toEqual(['crx-webRequest.dispatch', 3, 0, 'onResponseStarted'])
  })
})

describe('where a listener may be added from', () => {
  it('refuses a frame that is not one of the extension\'s own pages', () => {
    const { dispatcher } = setup()
    const host = fakeHost()
    host.getURL = () => 'https://site.example/framing-page.html'
    expect(() => { dispatcher.addListener(apiEvent(host), 'onCompleted', 1, FILTER, []) }).toThrow('webRequest listeners can be added only from the extension\'s own pages')
    expect(dispatcher.registrationCount('onCompleted')).toBe(0)
  })

  it('refuses another extension\'s page, and a look-alike id prefix', () => {
    const { dispatcher } = setup()
    expect(() => { dispatcher.addListener(apiEvent(fakeHost(OTHER)), 'onCompleted', 1, FILTER, []) }).toThrow(/own pages/)
    const host = fakeHost()
    host.getURL = () => `chrome-extension://${ME}evil/page.html`
    expect(() => { dispatcher.addListener(apiEvent(host), 'onCompleted', 1, FILTER, []) }).toThrow(/own pages/)
  })

  it('lets a worker add one', () => {
    const { dispatcher } = setup()
    const worker = { send: vi.fn(), isDestroyed: () => false }
    dispatcher.addListener({ type: 'service-worker', sender: worker as unknown as ApiEvent['sender'], extension: { id: ME, manifest: { manifest_version: 3 } } }, 'onCompleted', 1, FILTER, [])
    expect(dispatcher.registrationCount('onCompleted')).toBe(1)
  })
})

describe('apps stay out', () => {
  const app = 'https://app.example'
  const appOnly = (url: string): boolean => url.startsWith(app)

  it('hides a request for an app\'s URL, one an app\'s page made, and one an app initiated', () => {
    const { dispatcher, fake } = setup({ isAppOrigin: appOnly })
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onCompleted', 1, FILTER, [])
    fake.runs.get('onCompleted')?.(electronRequest({ url: `${app}/api` }))
    fake.runs.get('onCompleted')?.(electronRequest({ frame: { parent: null, frameTreeNodeId: 1, origin: app } }))
    expect(host.send).not.toHaveBeenCalled()
    fake.runs.get('onCompleted')?.(electronRequest())
    expect(host.send).toHaveBeenCalledTimes(1)
  })

  it('hides a request made by a page that is on an app\'s origin, whatever its frame says', () => {
    const { dispatcher, fake } = setup({ isAppOrigin: appOnly, pageUrl: `${app}/index.html` })
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onCompleted', 1, FILTER, [])
    fake.runs.get('onCompleted')?.(electronRequest())
    expect(host.send).not.toHaveBeenCalled()
  })
})

describe('permissions are read per request', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('sends nothing to an extension that no longer holds webRequest', () => {
    let held = true
    const { dispatcher, fake } = setup({ held: (_id, permission) => permission !== 'webRequest' || held })
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onCompleted', 1, FILTER, [])
    fake.runs.get('onCompleted')?.(electronRequest())
    expect(host.send).toHaveBeenCalledTimes(1)
    held = false
    fake.runs.get('onCompleted')?.(electronRequest())
    expect(host.send).toHaveBeenCalledTimes(1)
  })

  it('tells a listener that lost webRequestBlocking without waiting for it', async () => {
    let blocking = true
    const { dispatcher, fake } = setup({ held: (_id, permission) => permission !== 'webRequestBlocking' || blocking })
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onBeforeRequest', 1, FILTER, ['blocking'])
    blocking = false
    const soFar = {}
    expect(await fake.runs.get('onBeforeRequest')?.(electronRequest(), soFar)).toBe(soFar)
    expect((host.send.mock.calls[0] as unknown[])[2]).toBe(0)
  })

  it('asks for an extension\'s host permissions once per request and extension', () => {
    const { dispatcher, fake, hostPermissionsOf } = setup()
    const host = fakeHost()
    dispatcher.addListener(apiEvent(host), 'onCompleted', 1, FILTER, [])
    dispatcher.addListener(apiEvent(host), 'onCompleted', 2, FILTER, [])
    fake.runs.get('onCompleted')?.(electronRequest())
    expect(hostPermissionsOf).toHaveBeenCalledTimes(1)
  })
})
