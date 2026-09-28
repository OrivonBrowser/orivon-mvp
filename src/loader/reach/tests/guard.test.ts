import { describe, expect, it, vi } from 'vitest'
import type { ConnectSecureDecision } from '../../../broker/policy/connect-secure.js'
import { guardReachResponse, REACH_REVOCATION_POLL_MS } from '../guard.js'

function allow (host: string): ConnectSecureDecision {
  return { allowed: true, host }
}

const DENIED: ConnectSecureDecision = { allowed: false, code: 'denied', reason: 'no-pattern-match' }

describe('guardReachResponse', () => {
  it('a null body (HEAD/204/...) is returned unwrapped, and releases its slot immediately -- nothing streams, nothing could go stale', () => {
    const response = new Response(null, { status: 204 })
    let released = false

    const result = guardReachResponse(response, 'h.example', 443, async () => allow('h.example'), () => { released = true })

    expect(result).toBe(response)
    expect(released).toBe(true)
  })

  it('a clean EOF releases exactly once, with the body forwarded unchanged', async () => {
    const body = new ReadableStream<Uint8Array>({
      start (controller) { controller.enqueue(new Uint8Array([111, 107])); controller.close() }
    })
    const response = new Response(body, { status: 200 })
    let releases = 0

    const guarded = guardReachResponse(response, 'h.example', 443, async () => allow('h.example'), () => { releases += 1 })

    expect(await guarded.text()).toBe('ok')
    expect(releases).toBe(1)
  })

  it('A199: a revoke caught by the poll errors the body a page is still reading, rather than letting it end cleanly', async () => {
    vi.useFakeTimers()
    try {
      let allowed = true
      const body = new ReadableStream<Uint8Array>({
        start (controller) { controller.enqueue(new Uint8Array([1])) } // never closed -- a "slow endpoint" still open
      })
      const response = new Response(body, { status: 200 })
      let releases = 0
      const guarded = guardReachResponse(
        response, 'h.example', 443, async () => (allowed ? allow('h.example') : DENIED), () => { releases += 1 }
      )
      const reader = guarded.body?.getReader()
      if (reader === undefined) throw new Error('guarded response had no body')

      // The first chunk was already authorised -- reading it must succeed.
      expect((await reader.read()).done).toBe(false)

      // The row a person watching the permissions UI would see disappear
      // right now.
      allowed = false
      const pending = reader.read()
      // Pre-empts Node's unhandled-rejection detector: the poll settles
      // `pending` DURING the timer advance below, before the real
      // assertion gets a chance to attach its own handler on the next
      // microtask -- a second handler on the same promise is fine and does
      // not change what that assertion observes.
      pending.catch(() => {})
      await vi.advanceTimersByTimeAsync(REACH_REVOCATION_POLL_MS)

      // WHAT THE READING PAGE OBSERVES: a rejected read, not a truncated
      // body it could mistake for a complete one.
      await expect(pending).rejects.toThrow(/revoked/)
      expect(releases).toBe(1)

      // Idempotence: a later tick must not release the same slot twice.
      await vi.advanceTimersByTimeAsync(REACH_REVOCATION_POLL_MS * 3)
      expect(releases).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a broker fault while polling fails closed -- the app must not keep reading past a check that could not even run', async () => {
    vi.useFakeTimers()
    try {
      const body = new ReadableStream<Uint8Array>({ start (controller) { controller.enqueue(new Uint8Array([1])) } })
      const response = new Response(body, { status: 200 })
      let releases = 0
      const guarded = guardReachResponse(
        response, 'h.example', 443, async () => { throw new Error('broker unavailable') }, () => { releases += 1 }
      )
      const reader = guarded.body?.getReader()
      if (reader === undefined) throw new Error('guarded response had no body')
      await reader.read()

      const pending = reader.read()
      pending.catch(() => {}) // see the A199 test above for why this precedes the timer advance
      await vi.advanceTimersByTimeAsync(REACH_REVOCATION_POLL_MS)

      await expect(pending).rejects.toThrow()
      expect(releases).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the consumer cancelling its own read (navigation, an aborted fetch) still releases exactly once', async () => {
    const body = new ReadableStream<Uint8Array>({ start () {} })
    const response = new Response(body, { status: 200 })
    let releases = 0

    const guarded = guardReachResponse(response, 'h.example', 443, async () => allow('h.example'), () => { releases += 1 })
    if (guarded.body === null) throw new Error('guarded response had no body')

    await guarded.body.cancel('page navigated away')
    expect(releases).toBe(1)

    // A second cancel (belt-and-braces from a caller) must not double-release.
    await guarded.body.cancel('page navigated away')
    expect(releases).toBe(1)
  })
})
