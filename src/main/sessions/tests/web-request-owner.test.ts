import { describe, expect, it, vi } from 'vitest'
import type { Session, WebRequestFilter } from 'electron'
import { RUN_LAST, webRequestOwnerFor } from '../web-request-owner.js'

type Listener<D, R> = (details: D, callback: (result: R) => void) => void

interface FakeWebRequest {
  onBeforeRequest: ReturnType<typeof vi.fn>
  onBeforeSendHeaders: ReturnType<typeof vi.fn>
  onHeadersReceived: ReturnType<typeof vi.fn>
}

function fakeSession (): { session: Session, webRequest: FakeWebRequest } {
  const webRequest: FakeWebRequest = {
    onBeforeRequest: vi.fn(),
    onBeforeSendHeaders: vi.fn(),
    onHeadersReceived: vi.fn()
  }
  return { session: { webRequest } as unknown as Session, webRequest }
}

/** A filter distinct enough per call site to tell apart in a union assertion. */
const FILTER_A: WebRequestFilter = { urls: ['https://*.a.example/*'] }
const FILTER_B: WebRequestFilter = { urls: ['https://*.b.example/*'] }

describe('webRequestOwnerFor', () => {
  it('returns the SAME owner for the same session, on every call', () => {
    const { session } = fakeSession()
    expect(webRequestOwnerFor(session)).toBe(webRequestOwnerFor(session))
  })

  it('gives two different sessions two different owners', () => {
    const a = fakeSession().session
    const b = fakeSession().session
    expect(webRequestOwnerFor(a)).not.toBe(webRequestOwnerFor(b))
  })

  it('registers Electron\'s own onHeadersReceived exactly ONCE for the first handler, then RE-REGISTERS with the union filter as more handlers are added', () => {
    const { session, webRequest } = fakeSession()
    const owner = webRequestOwnerFor(session)
    owner.onHeadersReceived(1, FILTER_A, () => true, (_d, current) => current)
    expect(webRequest.onHeadersReceived).toHaveBeenCalledTimes(1)
    expect(webRequest.onHeadersReceived).toHaveBeenNthCalledWith(1, FILTER_A, expect.any(Function))

    owner.onHeadersReceived(2, FILTER_B, () => true, (_d, current) => current)
    expect(webRequest.onHeadersReceived).toHaveBeenCalledTimes(2)
    expect(webRequest.onHeadersReceived).toHaveBeenNthCalledWith(2, { urls: ['https://*.a.example/*', 'https://*.b.example/*'] }, expect.any(Function))

    // A third handler with a filter already covered by the union re-registers again (the owner does not try to detect "no-op" unions), but the FILTER itself stays the same union.
    owner.onHeadersReceived(3, FILTER_A, () => true, (_d, current) => current)
    expect(webRequest.onHeadersReceived).toHaveBeenCalledTimes(3)
    expect(webRequest.onHeadersReceived).toHaveBeenNthCalledWith(3, { urls: ['https://*.a.example/*', 'https://*.b.example/*'] }, expect.any(Function))
  })

  it('the same is true for onBeforeRequest and onBeforeSendHeaders, independently of each other and of onHeadersReceived', () => {
    const { session, webRequest } = fakeSession()
    const owner = webRequestOwnerFor(session)
    owner.onBeforeRequest(1, FILTER_A, () => true, () => ({}))
    owner.onBeforeRequest(2, FILTER_A, () => true, () => ({}))
    owner.onBeforeSendHeaders(1, FILTER_A, () => true, (_d, current) => current)
    expect(webRequest.onBeforeRequest).toHaveBeenCalledTimes(2)
    expect(webRequest.onBeforeSendHeaders).toHaveBeenCalledTimes(1)
    expect(webRequest.onHeadersReceived).not.toHaveBeenCalled()
  })

  // unionFilter (web-request-owner.ts's own doc): `<all_urls>` in any one
  // handler's filter dominates the union, since it is already broader than
  // anything else could add.
  it('a filter naming <all_urls> dominates the union of urls, whatever else is registered', () => {
    const { session, webRequest } = fakeSession()
    const owner = webRequestOwnerFor(session)
    owner.onHeadersReceived(1, FILTER_A, () => true, (_d, current) => current)
    owner.onHeadersReceived(2, { urls: ['<all_urls>'] }, () => true, (_d, current) => current)
    expect(webRequest.onHeadersReceived).toHaveBeenLastCalledWith({ urls: ['<all_urls>'] }, expect.any(Function))
  })

  // unionFilter's `types` half: an absent `types` on ANY handler means that
  // handler needs every resource type, so the union must not restrict by
  // type either -- a partial `types` list would otherwise silently narrow a
  // handler that asked for everything.
  it('a handler with no `types` restriction (wants every type) makes the union omit `types` entirely, even though a sibling handler restricted itself', () => {
    const { session, webRequest } = fakeSession()
    const owner = webRequestOwnerFor(session)
    owner.onHeadersReceived(1, { urls: ['<all_urls>'], types: ['mainFrame'] }, () => true, (_d, current) => current)
    owner.onHeadersReceived(2, { urls: ['<all_urls>'] }, () => true, (_d, current) => current)
    const [filter] = webRequest.onHeadersReceived.mock.calls[1] as [WebRequestFilter]
    expect(filter.types).toBeUndefined()
  })

  it('when every registered handler restricts `types`, the union is their combined, deduplicated set', () => {
    const { session, webRequest } = fakeSession()
    const owner = webRequestOwnerFor(session)
    owner.onHeadersReceived(1, { urls: ['<all_urls>'], types: ['mainFrame'] }, () => true, (_d, current) => current)
    owner.onHeadersReceived(2, { urls: ['<all_urls>'], types: ['mainFrame', 'subFrame'] }, () => true, (_d, current) => current)
    const [filter] = webRequest.onHeadersReceived.mock.calls[1] as [WebRequestFilter]
    expect(filter.types).toEqual(['mainFrame', 'subFrame'])
  })

  it('runs registered onHeadersReceived handlers in order, composing responseHeaders, and calls the real Electron callback exactly once', async () => {
    const { session, webRequest } = fakeSession()
    const owner = webRequestOwnerFor(session)
    owner.onHeadersReceived(RUN_LAST, FILTER_A, () => true, (_details, current) => ({
      ...current,
      responseHeaders: { ...current.responseHeaders, 'x-last': ['yes'] }
    }))
    owner.onHeadersReceived(1, FILTER_A, () => true, (_details, current) => ({
      ...current,
      responseHeaders: { ...current.responseHeaders, 'x-first': ['yes'] }
    }))

    const listener = webRequest.onHeadersReceived.mock.calls[1]?.[1] as Listener<{ url: string, responseHeaders?: Record<string, string[]> }, { responseHeaders?: Record<string, string[]> }>
    const callback = vi.fn()
    listener({ url: 'https://a.example/', responseHeaders: { 'content-type': ['text/html'] } }, callback)
    await new Promise((resolve) => { setImmediate(resolve) })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({
      responseHeaders: { 'content-type': ['text/html'], 'x-first': ['yes'], 'x-last': ['yes'] }
    })
  })

  // A seeded `{ responseHeaders: details.responseHeaders ?? {} }` handed
  // straight to Electron's callback whenever nothing changed it would answer
  // a response whose `details.responseHeaders` was genuinely undefined with
  // an EXPLICIT empty header set -- Electron reads that as "the server sent
  // no headers; use none", stripping every real header the response
  // actually carried. An unchanged result must answer with a bare `{}`,
  // Electron's own "nothing to say" (`web-request-owner.ts`'s own doc on
  // `registerHeadersReceived`).
  it('a handler outside its own predicate\'s match is skipped, and the callback runs with a bare {} -- never a seeded empty header set', async () => {
    const { session, webRequest } = fakeSession()
    const owner = webRequestOwnerFor(session)
    const outOfScope = vi.fn((_d: unknown, current: { responseHeaders: Record<string, string[]> }) => current)
    owner.onHeadersReceived(1, FILTER_A, (url) => url.includes('b.example'), outOfScope)

    const listener = webRequest.onHeadersReceived.mock.calls[0]?.[1] as Listener<{ url: string, responseHeaders?: Record<string, string[]> }, { responseHeaders?: Record<string, string[]> }>
    const callback = vi.fn()
    // No `responseHeaders` key at all -- the exact shape a response with none actually has.
    listener({ url: 'https://a.example/' }, callback)
    await new Promise((resolve) => { setImmediate(resolve) })

    expect(outOfScope).not.toHaveBeenCalled()
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({})
  })

  it('a handler that throws is logged, and the callback still fires once with a bare {} (nothing was actually changed)', async () => {
    const { session, webRequest } = fakeSession()
    const owner = webRequestOwnerFor(session)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      owner.onHeadersReceived(1, FILTER_A, () => true, () => { throw new Error('boom') })
      const listener = webRequest.onHeadersReceived.mock.calls[0]?.[1] as Listener<{ url: string, responseHeaders?: Record<string, string[]> }, { responseHeaders?: Record<string, string[]> }>
      const callback = vi.fn()
      listener({ url: 'https://a.example/', responseHeaders: { a: ['1'] } }, callback)
      await new Promise((resolve) => { setImmediate(resolve) })
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback).toHaveBeenCalledWith({})
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  // Same "unchanged -> bare {}" rule, for onBeforeSendHeaders.
  it('onBeforeSendHeaders answers with a bare {} when no handler changes the request headers', async () => {
    const { session, webRequest } = fakeSession()
    const owner = webRequestOwnerFor(session)
    owner.onBeforeSendHeaders(1, FILTER_A, (url) => url.includes('never-matches'), (_d, current) => current)

    const listener = webRequest.onBeforeSendHeaders.mock.calls[0]?.[1] as Listener<{ url: string, requestHeaders: Record<string, string> }, { requestHeaders?: Record<string, string> }>
    const callback = vi.fn()
    listener({ url: 'https://a.example/', requestHeaders: { 'user-agent': 'x' } }, callback)
    await new Promise((resolve) => { setImmediate(resolve) })

    expect(callback).toHaveBeenCalledWith({})
  })

  it('onBeforeSendHeaders answers with the real result when a handler actually changes the headers', async () => {
    const { session, webRequest } = fakeSession()
    const owner = webRequestOwnerFor(session)
    owner.onBeforeSendHeaders(1, FILTER_A, () => true, (_d, current) => ({ ...current, requestHeaders: { ...current.requestHeaders, 'x-stamp': 'yes' } }))

    const listener = webRequest.onBeforeSendHeaders.mock.calls[0]?.[1] as Listener<{ url: string, requestHeaders: Record<string, string> }, { requestHeaders?: Record<string, string> }>
    const callback = vi.fn()
    listener({ url: 'https://a.example/', requestHeaders: { 'user-agent': 'x' } }, callback)
    await new Promise((resolve) => { setImmediate(resolve) })

    expect(callback).toHaveBeenCalledWith({ requestHeaders: { 'user-agent': 'x', 'x-stamp': 'yes' } })
  })

  it('onBeforeRequest: the first handler that cancels or redirects wins, and a later handler is never asked', async () => {
    const { session, webRequest } = fakeSession()
    const owner = webRequestOwnerFor(session)
    const later = vi.fn(() => ({}))
    owner.onBeforeRequest(1, FILTER_A, () => true, () => ({ redirectURL: 'https://elsewhere.example/' }))
    owner.onBeforeRequest(2, FILTER_A, () => true, later)

    const listener = webRequest.onBeforeRequest.mock.calls[1]?.[1] as Listener<{ url: string }, { redirectURL?: string }>
    const callback = vi.fn()
    listener({ url: 'https://a.example/' }, callback)
    await new Promise((resolve) => { setImmediate(resolve) })

    expect(later).not.toHaveBeenCalled()
    expect(callback).toHaveBeenCalledWith({ redirectURL: 'https://elsewhere.example/' })
  })

  it('remove() re-registers with the union of what remains, dropped handler excluded', () => {
    const { session, webRequest } = fakeSession()
    const owner = webRequestOwnerFor(session)
    owner.onHeadersReceived(1, FILTER_A, () => true, (_d, current) => current)
    const handleB = owner.onHeadersReceived(2, FILTER_B, () => true, (_d, current) => current)
    expect(webRequest.onHeadersReceived).toHaveBeenLastCalledWith(
      { urls: ['https://*.a.example/*', 'https://*.b.example/*'] },
      expect.any(Function)
    )

    handleB.remove()
    expect(webRequest.onHeadersReceived).toHaveBeenLastCalledWith(FILTER_A, expect.any(Function))
  })

  it('remove()-ing the last handler for an event unregisters Electron\'s own listener with null, not an empty { urls: [] } filter', () => {
    const { session, webRequest } = fakeSession()
    const owner = webRequestOwnerFor(session)
    const handle = owner.onBeforeRequest(1, FILTER_A, () => true, () => ({}))
    expect(webRequest.onBeforeRequest).toHaveBeenCalledTimes(1)

    handle.remove()
    expect(webRequest.onBeforeRequest).toHaveBeenCalledTimes(2)
    expect(webRequest.onBeforeRequest).toHaveBeenLastCalledWith(null)
  })

  it('a second onBeforeRequest handler keeps Electron\'s listener registered after the first is removed', () => {
    const { session, webRequest } = fakeSession()
    const owner = webRequestOwnerFor(session)
    const handleA = owner.onBeforeRequest(1, FILTER_A, () => true, () => ({}))
    owner.onBeforeRequest(2, FILTER_B, () => true, () => ({}))

    handleA.remove()
    expect(webRequest.onBeforeRequest).toHaveBeenLastCalledWith(FILTER_B, expect.any(Function))
  })
})
