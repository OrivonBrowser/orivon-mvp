import { describe, expect, it, vi } from 'vitest'
import type { Session, WebRequestFilter } from 'electron'
import { webRequestOwnerFor } from '../web-request-owner.js'

const EVENTS = ['onSendHeaders', 'onResponseStarted', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred'] as const

function fakeSession (): { session: Session, webRequest: Record<(typeof EVENTS)[number], ReturnType<typeof vi.fn>> } {
  const webRequest = Object.fromEntries(EVENTS.map((name) => [name, vi.fn()])) as Record<(typeof EVENTS)[number], ReturnType<typeof vi.fn>>
  return { session: { webRequest } as unknown as Session, webRequest }
}

const FILTER_A: WebRequestFilter = { urls: ['https://*.a.example/*'] }
const FILTER_B: WebRequestFilter = { urls: ['https://*.b.example/*'] }

describe('the owner\'s observer events', () => {
  for (const event of EVENTS) {
    describe(event, () => {
      it('registers Electron\'s listener with the union filter, and unregisters it when the last handler leaves', () => {
        const { session, webRequest } = fakeSession()
        const owner = webRequestOwnerFor(session)
        const first = owner[event](FILTER_A, () => true, () => {})
        expect(webRequest[event]).toHaveBeenLastCalledWith(FILTER_A, expect.any(Function))
        const second = owner[event](FILTER_B, () => true, () => {})
        expect(webRequest[event]).toHaveBeenLastCalledWith({ urls: ['https://*.a.example/*', 'https://*.b.example/*'] }, expect.any(Function))
        first.remove()
        expect(webRequest[event]).toHaveBeenLastCalledWith(FILTER_B, expect.any(Function))
        second.remove()
        expect(webRequest[event]).toHaveBeenLastCalledWith(null)
      })

      it('runs every handler whose predicate matches, and never one whose predicate refuses', () => {
        const { session, webRequest } = fakeSession()
        const owner = webRequestOwnerFor(session)
        const a = vi.fn()
        const b = vi.fn()
        const refused = vi.fn()
        owner[event](FILTER_A, () => true, a)
        owner[event](FILTER_A, () => true, b)
        owner[event](FILTER_A, () => false, refused)
        const listener = webRequest[event].mock.calls.at(-1)?.[1] as (details: unknown) => void
        const details = { url: 'https://x.a.example/' }
        listener(details)
        expect(a).toHaveBeenCalledWith(details)
        expect(b).toHaveBeenCalledWith(details)
        expect(refused).not.toHaveBeenCalled()
      })

      it('logs a throwing handler and still runs the others', () => {
        const { session, webRequest } = fakeSession()
        const owner = webRequestOwnerFor(session)
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        try {
          const after = vi.fn()
          owner[event](FILTER_A, () => true, () => { throw new Error('boom') })
          owner[event](FILTER_A, () => true, after)
          const listener = webRequest[event].mock.calls.at(-1)?.[1] as (details: unknown) => void
          listener({ url: 'https://x.a.example/' })
          expect(after).toHaveBeenCalledTimes(1)
          expect(errorSpy).toHaveBeenCalled()
        } finally {
          errorSpy.mockRestore()
        }
      })

      it('lets a handler leave from inside its own call without skipping the next one', () => {
        const { session, webRequest } = fakeSession()
        const owner = webRequestOwnerFor(session)
        const next = vi.fn()
        const handle = owner[event](FILTER_A, () => true, () => { handle.remove() })
        owner[event](FILTER_A, () => true, next)
        const listener = webRequest[event].mock.calls.at(-1)?.[1] as (details: unknown) => void
        listener({ url: 'https://x.a.example/' })
        expect(next).toHaveBeenCalledTimes(1)
      })
    })
  }

  it('keeps the five events independent of one another', () => {
    const { session, webRequest } = fakeSession()
    webRequestOwnerFor(session).onCompleted(FILTER_A, () => true, () => {})
    expect(webRequest.onCompleted).toHaveBeenCalledTimes(1)
    expect(webRequest.onErrorOccurred).not.toHaveBeenCalled()
  })
})
