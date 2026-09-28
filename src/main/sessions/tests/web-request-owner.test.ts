import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'
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

  it('registers Electron\'s own onHeadersReceived exactly ONCE, however many handlers this owner is given, and with NO url filter', () => {
    const { session, webRequest } = fakeSession()
    const owner = webRequestOwnerFor(session)
    owner.onHeadersReceived(1, () => true, (_d, current) => current)
    owner.onHeadersReceived(2, () => true, (_d, current) => current)
    owner.onHeadersReceived(3, () => true, (_d, current) => current)
    expect(webRequest.onHeadersReceived).toHaveBeenCalledTimes(1)
    expect(webRequest.onHeadersReceived).toHaveBeenCalledWith(expect.any(Function))
  })

  it('the same is true for onBeforeRequest and onBeforeSendHeaders, independently of each other and of onHeadersReceived', () => {
    const { session, webRequest } = fakeSession()
    const owner = webRequestOwnerFor(session)
    owner.onBeforeRequest(1, () => true, () => ({}))
    owner.onBeforeRequest(2, () => true, () => ({}))
    owner.onBeforeSendHeaders(1, () => true, (_d, current) => current)
    expect(webRequest.onBeforeRequest).toHaveBeenCalledTimes(1)
    expect(webRequest.onBeforeSendHeaders).toHaveBeenCalledTimes(1)
    expect(webRequest.onHeadersReceived).not.toHaveBeenCalled()
  })

  it('runs registered onHeadersReceived handlers in order, composing responseHeaders, and calls the real Electron callback exactly once', async () => {
    const { session, webRequest } = fakeSession()
    const owner = webRequestOwnerFor(session)
    owner.onHeadersReceived(RUN_LAST, () => true, (_details, current) => ({
      ...current,
      responseHeaders: { ...current.responseHeaders, 'x-last': ['yes'] }
    }))
    owner.onHeadersReceived(1, () => true, (_details, current) => ({
      ...current,
      responseHeaders: { ...current.responseHeaders, 'x-first': ['yes'] }
    }))

    const listener = webRequest.onHeadersReceived.mock.calls[0]?.[0] as Listener<{ url: string, responseHeaders?: Record<string, string[]> }, { responseHeaders?: Record<string, string[]> }>
    const callback = vi.fn()
    listener({ url: 'https://a.example/', responseHeaders: { 'content-type': ['text/html'] } }, callback)
    await new Promise((resolve) => { setImmediate(resolve) })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({
      responseHeaders: { 'content-type': ['text/html'], 'x-first': ['yes'], 'x-last': ['yes'] }
    })
  })

  it('a handler outside its own predicate\'s match is skipped, and the callback still runs exactly once', async () => {
    const { session, webRequest } = fakeSession()
    const owner = webRequestOwnerFor(session)
    const outOfScope = vi.fn((_d: unknown, current: { responseHeaders: Record<string, string[]> }) => current)
    owner.onHeadersReceived(1, (url) => url.includes('b.example'), outOfScope)

    const listener = webRequest.onHeadersReceived.mock.calls[0]?.[0] as Listener<{ url: string, responseHeaders?: Record<string, string[]> }, { responseHeaders?: Record<string, string[]> }>
    const callback = vi.fn()
    listener({ url: 'https://a.example/' }, callback)
    await new Promise((resolve) => { setImmediate(resolve) })

    expect(outOfScope).not.toHaveBeenCalled()
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({ responseHeaders: {} })
  })

  it('a handler that throws is logged, and the callback still fires once with the unmodified value', async () => {
    const { session, webRequest } = fakeSession()
    const owner = webRequestOwnerFor(session)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      owner.onHeadersReceived(1, () => true, () => { throw new Error('boom') })
      const listener = webRequest.onHeadersReceived.mock.calls[0]?.[0] as Listener<{ url: string, responseHeaders?: Record<string, string[]> }, { responseHeaders?: Record<string, string[]> }>
      const callback = vi.fn()
      listener({ url: 'https://a.example/', responseHeaders: { a: ['1'] } }, callback)
      await new Promise((resolve) => { setImmediate(resolve) })
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback).toHaveBeenCalledWith({ responseHeaders: { a: ['1'] } })
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('onBeforeRequest: the first handler that cancels or redirects wins, and a later handler is never asked', async () => {
    const { session, webRequest } = fakeSession()
    const owner = webRequestOwnerFor(session)
    const later = vi.fn(() => ({}))
    owner.onBeforeRequest(1, () => true, () => ({ redirectURL: 'https://elsewhere.example/' }))
    owner.onBeforeRequest(2, () => true, later)

    const listener = webRequest.onBeforeRequest.mock.calls[0]?.[0] as Listener<{ url: string }, { redirectURL?: string }>
    const callback = vi.fn()
    listener({ url: 'https://a.example/' }, callback)
    await new Promise((resolve) => { setImmediate(resolve) })

    expect(later).not.toHaveBeenCalled()
    expect(callback).toHaveBeenCalledWith({ redirectURL: 'https://elsewhere.example/' })
  })
})
