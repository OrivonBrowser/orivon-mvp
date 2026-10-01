import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'

// installDnrWebRequestHandlers subscribes to extensions-dnr.ts's own
// onDnrActiveChange at module scope; this test controls when it fires
// instead of driving a real Session's 'extension-loaded'/'-unloaded'.
let dnrActiveListener: ((active: boolean) => void) | undefined
vi.mock('../extensions-dnr.js', () => ({
  onDnrActiveChange: (listener: (active: boolean) => void) => { dnrActiveListener = listener }
}))

import {
  applyRequestHeaders,
  applyResponseHeaders,
  frameIdOf,
  initiatorOf,
  installDnrWebRequestHandlers,
  parentFrameIdOf,
  toHttpsUrl,
  toScopedRequest,
} from '../dnr-webrequest.js'

function fakeSession(): { session: Session, webRequest: Record<'onBeforeRequest' | 'onBeforeSendHeaders' | 'onHeadersReceived', ReturnType<typeof vi.fn>> } {
  const webRequest = {
    onBeforeRequest: vi.fn(),
    onBeforeSendHeaders: vi.fn(),
    onHeadersReceived: vi.fn(),
  }
  return { session: { webRequest } as unknown as Session, webRequest }
}

interface FakeFrame {
  readonly parent: FakeFrame | null
  readonly frameTreeNodeId: number
  readonly origin: string
}

function fakeFrame(overrides: Partial<FakeFrame> & { frameTreeNodeId: number }): FakeFrame {
  return { parent: null, origin: 'https://example.com', ...overrides }
}

describe('frameIdOf / parentFrameIdOf', () => {
  it('the top frame (no parent) is always 0', () => {
    const top = fakeFrame({ frameTreeNodeId: 42 })
    expect(frameIdOf(top as any)).toBe(0)
    expect(parentFrameIdOf(top as any)).toBeUndefined()
  })

  it('a sub_frame uses its own frameTreeNodeId, and its parentFrameId is the parent\'s mapped id', () => {
    const top = fakeFrame({ frameTreeNodeId: 1 })
    const child = fakeFrame({ frameTreeNodeId: 7, parent: top })
    expect(frameIdOf(child as any)).toBe(7)
    expect(parentFrameIdOf(child as any)).toBe(0)
  })

  it('a grandchild frame\'s parentFrameId is the child\'s own frameTreeNodeId, not 0', () => {
    const top = fakeFrame({ frameTreeNodeId: 1 })
    const child = fakeFrame({ frameTreeNodeId: 7, parent: top })
    const grandchild = fakeFrame({ frameTreeNodeId: 9, parent: child })
    expect(frameIdOf(grandchild as any)).toBe(9)
    expect(parentFrameIdOf(grandchild as any)).toBe(7)
  })
})

describe('initiatorOf', () => {
  it('is the frame\'s own origin', () => {
    const frame = fakeFrame({ frameTreeNodeId: 1, origin: 'https://a.example/' })
    expect(initiatorOf(frame as any)).toBe('https://a.example/')
  })

  it('is undefined for a null frame, an opaque ("null") origin, or an empty origin', () => {
    expect(initiatorOf(null)).toBeUndefined()
    expect(initiatorOf(fakeFrame({ frameTreeNodeId: 1, origin: 'null' }) as any)).toBeUndefined()
    expect(initiatorOf(fakeFrame({ frameTreeNodeId: 1, origin: '' }) as any)).toBeUndefined()
  })

  it('is undefined if reading .origin throws (a destroyed/navigated frame)', () => {
    const throwing = { parent: null, frameTreeNodeId: 1, get origin(): string { throw new Error('destroyed') } }
    expect(initiatorOf(throwing as any)).toBeUndefined()
  })
})

describe('toScopedRequest', () => {
  it('is null for a request with no webContents (main-process net.fetch, the verifier)', () => {
    expect(toScopedRequest({ url: 'https://a.example/', method: 'GET', resourceType: 'other' })).toBeNull()
  })

  it('maps a main_frame request to tabId/frameId 0/resourceType main_frame, initiator from the PREVIOUS document (frame.origin pre-commit)', () => {
    const scoped = toScopedRequest({
      url: 'https://a.example/',
      method: 'GET',
      resourceType: 'mainFrame',
      webContentsId: 5,
      frame: fakeFrame({ frameTreeNodeId: 99, origin: 'https://previous.example/' }) as any,
    })
    expect(scoped).toEqual({
      tabId: 5,
      dnrRequest: {
        url: 'https://a.example/',
        method: 'GET',
        resourceType: 'main_frame',
        initiator: 'https://previous.example/',
        tabId: 5,
        frameId: 0,
      },
    })
  })

  it('maps a sub_frame\'s subresource with the sub_frame\'s own frameId as both frameId and initiator source', () => {
    const top = fakeFrame({ frameTreeNodeId: 1, origin: 'https://top.example/' })
    const sub = fakeFrame({ frameTreeNodeId: 3, parent: top, origin: 'https://sub.example/' })
    const scoped = toScopedRequest({
      url: 'https://cdn.example/x.js',
      method: 'GET',
      resourceType: 'script',
      webContentsId: 5,
      frame: sub as any,
    })
    expect(scoped?.dnrRequest).toEqual({
      url: 'https://cdn.example/x.js',
      method: 'GET',
      resourceType: 'script',
      initiator: 'https://sub.example/',
      tabId: 5,
      frameId: 3,
      parentFrameId: 0,
    })
  })

  it('falls back to frameId 0 and no parentFrameId when .frame is unavailable, without throwing', () => {
    const scoped = toScopedRequest({ url: 'https://a.example/', method: 'GET', resourceType: 'other', webContentsId: 1, frame: null })
    expect(scoped?.dnrRequest.frameId).toBe(0)
    expect(scoped?.dnrRequest.parentFrameId).toBeUndefined()
  })
})

describe('toHttpsUrl', () => {
  it('upgrades an http URL, preserving path/query', () => {
    expect(toHttpsUrl('http://a.example/path?x=1')).toBe('https://a.example/path?x=1')
  })

  it('refuses a non-http URL', () => {
    expect(toHttpsUrl('https://a.example/')).toBeNull()
    expect(toHttpsUrl('chrome-extension://abc/x')).toBeNull()
  })

  it('refuses an unparsable URL rather than throwing', () => {
    expect(toHttpsUrl('not a url')).toBeNull()
  })
})

describe('applyRequestHeaders', () => {
  it('sets, appends (joining with ", " for a non-Cookie header) and removes', () => {
    const base = { 'X-Existing': 'a' }
    const result = applyRequestHeaders(base, [
      { header: 'X-Existing', operation: 'append', value: 'b' },
      { header: 'X-New', operation: 'set', value: 'v' },
    ])
    expect(result).toEqual({ 'X-Existing': 'a, b', 'X-New': 'v' })
  })

  it('appends to Cookie with "; ", per RFC 6265 (dnr/README.md\'s own note)', () => {
    const result = applyRequestHeaders({ Cookie: 'a=1' }, [{ header: 'Cookie', operation: 'append', value: 'b=2' }])
    expect(result.Cookie).toBe('a=1; b=2')
  })

  it('is case-insensitive when matching an existing header name', () => {
    const result = applyRequestHeaders({ 'x-existing': 'a' }, [{ header: 'X-Existing', operation: 'remove' }])
    expect(result).toEqual({})
  })

  it('returns the same object reference when there are no ops (no unnecessary copy)', () => {
    const base = { a: '1' }
    expect(applyRequestHeaders(base, undefined)).toBe(base)
    expect(applyRequestHeaders(base, [])).toBe(base)
  })
})

describe('applyResponseHeaders', () => {
  it('sets a header as a single-element array', () => {
    expect(applyResponseHeaders({}, [{ header: 'X-Dnr', operation: 'set', value: '1' }])).toEqual({ 'X-Dnr': ['1'] })
  })

  it('removes a header', () => {
    expect(applyResponseHeaders({ 'X-Dnr': ['1'] }, [{ header: 'X-Dnr', operation: 'remove' }])).toEqual({})
  })

  it('appends onto the existing array', () => {
    expect(applyResponseHeaders({ 'Set-Cookie': ['a=1'] }, [{ header: 'Set-Cookie', operation: 'append', value: 'b=2' }])).toEqual({
      'Set-Cookie': ['a=1', 'b=2'],
    })
  })
})

describe('installDnrWebRequestHandlers', () => {
  it('registers nothing while onDnrActiveChange starts inactive', () => {
    const { session, webRequest } = fakeSession()
    dnrActiveListener = undefined
    installDnrWebRequestHandlers(session, () => undefined)
    expect(dnrActiveListener).toBeDefined()
    dnrActiveListener!(false)
    expect(webRequest.onBeforeRequest).not.toHaveBeenCalled()
    expect(webRequest.onBeforeSendHeaders).not.toHaveBeenCalled()
    expect(webRequest.onHeadersReceived).not.toHaveBeenCalled()
  })

  it('registers all three handlers with <all_urls> once active, and un-registers (Electron\'s own null) once inactive again', () => {
    const { session, webRequest } = fakeSession()
    dnrActiveListener = undefined
    installDnrWebRequestHandlers(session, () => undefined)

    dnrActiveListener!(true)
    expect(webRequest.onBeforeRequest).toHaveBeenLastCalledWith({ urls: ['<all_urls>'] }, expect.any(Function))
    expect(webRequest.onBeforeSendHeaders).toHaveBeenLastCalledWith({ urls: ['<all_urls>'] }, expect.any(Function))
    expect(webRequest.onHeadersReceived).toHaveBeenLastCalledWith({ urls: ['<all_urls>'] }, expect.any(Function))

    dnrActiveListener!(false)
    expect(webRequest.onBeforeRequest).toHaveBeenLastCalledWith(null)
    expect(webRequest.onBeforeSendHeaders).toHaveBeenLastCalledWith(null)
    expect(webRequest.onHeadersReceived).toHaveBeenLastCalledWith(null)
  })

  it('registering twice while already active is a no-op (no duplicate handler)', () => {
    const { session, webRequest } = fakeSession()
    dnrActiveListener = undefined
    installDnrWebRequestHandlers(session, () => undefined)

    dnrActiveListener!(true)
    const callsAfterFirst = webRequest.onBeforeRequest.mock.calls.length
    dnrActiveListener!(true)
    expect(webRequest.onBeforeRequest.mock.calls.length).toBe(callsAfterFirst)
  })

  describe('answering Electron', () => {
    type Listener = (details: Record<string, unknown>, callback: (result: unknown) => void) => void
    const decisionOf = (extra: Record<string, unknown>) => ({ matchedRules: [], ...extra })

    function active (decision: Record<string, unknown>) {
      const { session, webRequest } = fakeSession()
      dnrActiveListener = undefined
      installDnrWebRequestHandlers(session, () => ({ evaluate: () => decision }) as never)
      dnrActiveListener!(true)
      const listener = (name: 'onBeforeSendHeaders' | 'onHeadersReceived'): Listener => webRequest[name].mock.calls.at(-1)![1] as Listener
      return { listener }
    }
    const request = { url: 'https://a.example/x', method: 'GET', resourceType: 'xhr', webContentsId: 7 }

    it('answers a request no header rule touched with a bare {}, so Electron keeps its own headers', async () => {
      const { listener } = active(decisionOf({}))
      const callback = vi.fn()
      listener('onBeforeSendHeaders')({ ...request, requestHeaders: { Accept: '*/*' } }, callback)
      await vi.waitFor(() => { expect(callback).toHaveBeenCalledTimes(1) })
      expect(callback).toHaveBeenCalledWith({})
    })

    it('never answers a response whose headers were undefined with an explicit empty set', async () => {
      const { listener } = active(decisionOf({}))
      const callback = vi.fn()
      listener('onHeadersReceived')({ ...request }, callback)
      await vi.waitFor(() => { expect(callback).toHaveBeenCalledTimes(1) })
      expect(callback).toHaveBeenCalledWith({})
    })

    it('sends the changed headers when a modifyHeaders rule matched', async () => {
      const { listener } = active(decisionOf({ requestHeaders: [{ header: 'X-Test', operation: 'set', value: '1' }] }))
      const callback = vi.fn()
      listener('onBeforeSendHeaders')({ ...request, requestHeaders: { Accept: '*/*' } }, callback)
      await vi.waitFor(() => { expect(callback).toHaveBeenCalledTimes(1) })
      expect(callback).toHaveBeenCalledWith({ requestHeaders: { Accept: '*/*', 'X-Test': '1' } })
    })
  })
})
