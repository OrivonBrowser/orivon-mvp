// orivon.web's three entry points (../web-capability.ts), exercised through
// createBroker exactly the way id-capability.test.ts exercises orivon.id --
// same fixtures (index.test-helpers.ts), same "grant, then call" shape.
// ADR-0019's own security properties this file proves, unit-level:
//   - a denial never says whether the origin was ungranted or the grant was
//     for another origin (the two 'denied' tests below carry no platformCode
//     and no distinguishing message);
//   - LIMITS.webContexts caps concurrent contexts per opener;
//   - evaluate is one-at-a-time per context, times out, and caps its script
//     and result sizes;
//   - revoking the web.context grant closes every context it authorised,
//     rejecting a pending evaluate and the handle's own `closed` with
//     'revoked' -- the SAME handleTable.revoke cascade net.connect's own
//     sockets answer to, not a second mechanism.
// The host itself is a fake here -- the real Electron implementation
// (src/main/web-context-host.ts) is exercised against fakes in its own
// test file, and end to end in test/e2e-web-context.test.ts.

import { describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../../contracts/index.js'
import type { WebContextHost } from '../broker-contracts.js'
import { createBroker } from '../index.js'
import { APP, baseDeps, manifestWith } from './index.test-helpers.js'

const CONTEXT_ORIGIN = 'https://example.com'
const OTHER_CONTEXT_ORIGIN = 'https://other.example'

interface FakeHost extends WebContextHost {
  readonly opened: Array<{ opener: string, origin: string, size: { width: number, height: number } }>
  readonly closed: string[]
  /** Test-only trigger for `onGone` -- simulates the host reporting that `id`'s own renderer died on its own (Finding 3). A no-op if nothing ever registered a listener. */
  simulateGone: (id: string, platformCode: string) => void
}

function fakeHost (overrides: Partial<WebContextHost> = {}): FakeHost {
  const opened: FakeHost['opened'] = []
  const closed: string[] = []
  let counter = 0
  let goneListener: ((id: string, platformCode: string) => void) | undefined
  return {
    opened,
    closed,
    open: async (opener, origin, size) => {
      opened.push({ opener, origin, size })
      counter += 1
      return `host-${String(counter)}`
    },
    evaluate: async (_id, script) => `evaluated:${script}`,
    close: async (id) => { closed.push(id) },
    onGone: (listener) => { goneListener = listener },
    simulateGone: (id, platformCode) => { goneListener?.(id, platformCode) },
    ...overrides
  }
}

function brokerWithHost (host: WebContextHost, patterns: readonly string[] = [CONTEXT_ORIGIN]): ReturnType<typeof createBroker> {
  const broker = createBroker(baseDeps({ webContextHost: host }))
  broker.registerApp(APP, manifestWith({ web: { contexts: patterns } }))
  return broker
}

async function grantedBroker (host: WebContextHost, patterns: readonly string[] = [CONTEXT_ORIGIN]): Promise<ReturnType<typeof createBroker>> {
  const broker = brokerWithHost(host, patterns)
  await broker.grant(APP, 'web.context', patterns)
  return broker
}

describe('orivon.web.openContext', () => {
  it('is denied when the origin holds no web.context grant at all', async () => {
    const broker = brokerWithHost(fakeHost())
    await expect(broker.web.openContext(APP, { origin: CONTEXT_ORIGIN }))
      .rejects.toMatchObject({ code: 'denied' })
  })

  it('is denied when a web.context grant exists but names a DIFFERENT origin', async () => {
    const broker = await grantedBroker(fakeHost(), [OTHER_CONTEXT_ORIGIN])
    await expect(broker.web.openContext(APP, { origin: CONTEXT_ORIGIN }))
      .rejects.toMatchObject({ code: 'denied' })
  })

  it('the two denials above are indistinguishable -- neither carries a platformCode', async () => {
    const neverGranted = brokerWithHost(fakeHost())
    const otherOrigin = await grantedBroker(fakeHost(), [OTHER_CONTEXT_ORIGIN])

    const first = await neverGranted.web.openContext(APP, { origin: CONTEXT_ORIGIN }).catch((e: unknown) => e)
    const second = await otherOrigin.web.openContext(APP, { origin: CONTEXT_ORIGIN }).catch((e: unknown) => e)

    expect((first as { code?: unknown }).code).toBe('denied')
    expect((second as { code?: unknown }).code).toBe('denied')
    expect((first as { platformCode?: unknown }).platformCode).toBeUndefined()
    expect((second as { platformCode?: unknown }).platformCode).toBeUndefined()
  })

  it('rejects internal when no WebContextHost is wired in', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ web: { contexts: [CONTEXT_ORIGIN] } }))
    await broker.grant(APP, 'web.context', [CONTEXT_ORIGIN])

    await expect(broker.web.openContext(APP, { origin: CONTEXT_ORIGIN }))
      .rejects.toMatchObject({ code: 'internal' })
  })

  it('opens a context under a matching grant, calling the host with the canonical opener and the default 1920x1080 viewport', async () => {
    const host = fakeHost()
    const broker = await grantedBroker(host)

    const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

    expect(context.origin).toBe(CONTEXT_ORIGIN)
    expect(typeof context.id).toBe('string')
    expect(host.opened).toEqual([{ opener: APP, origin: CONTEXT_ORIGIN, size: { width: 1920, height: 1080 } }])
  })

  it('passes a caller-chosen viewport through to the host', async () => {
    const host = fakeHost()
    const broker = await grantedBroker(host)

    await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN, width: 800, height: 600 })

    expect(host.opened[0]?.size).toEqual({ width: 800, height: 600 })
  })

  it('clamps an out-of-range viewport to 1..7680 rather than passing it through unchecked', async () => {
    const host = fakeHost()
    const broker = await grantedBroker(host)

    await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN, width: 0, height: 999_999 })

    expect(host.opened[0]?.size).toEqual({ width: 1, height: 7680 })
  })

  it('rejects invalid for a context origin that is not an exact https origin', async () => {
    const broker = await grantedBroker(fakeHost())
    await expect(broker.web.openContext(APP, { origin: 'https://example.com/path' }))
      .rejects.toMatchObject({ code: 'invalid' })
  })

  it('allows exactly LIMITS.webContexts contexts for one opener and refuses the next', async () => {
    const broker = await grantedBroker(fakeHost())
    for (let i = 0; i < LIMITS.webContexts; i += 1) {
      await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })
    }

    await expect(broker.web.openContext(APP, { origin: CONTEXT_ORIGIN }))
      .rejects.toMatchObject({ code: 'limit' })
  })
})

// Finding 2 of the security review: `openContext` awaited `host.open`
// unbounded while `evaluate` was already bounded by the same
// LIMITS.webContextEvaluateMs budget -- a hung host could stall a caller
// forever.
describe('orivon.web.openContext -- a slow or stalled host', () => {
  it('times out after LIMITS.webContextEvaluateMs when host.open never resolves', async () => {
    vi.useFakeTimers()
    try {
      const host = fakeHost({ open: async () => await new Promise(() => {}) })
      const broker = await grantedBroker(host)

      const pending = broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })
      const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(LIMITS.webContextEvaluateMs + 1)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes a context that the host resolves AFTER openContext already timed out, so nothing leaks', async () => {
    vi.useFakeTimers()
    try {
      let resolveOpen: ((id: string) => void) | undefined
      const host = fakeHost({ open: async () => await new Promise<string>((resolve) => { resolveOpen = resolve }) })
      const broker = await grantedBroker(host)

      const pending = broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })
      const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(LIMITS.webContextEvaluateMs + 1)
      await assertion

      resolveOpen?.('host-late')
      // Two ticks: one for the `.then()` this file's own late-resolve
      // handler runs on, one for `host.close`'s own async body.
      await Promise.resolve()
      await Promise.resolve()

      expect(host.closed).toEqual(['host-late'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('WebContext.evaluate (via orivon.web.evaluate)', () => {
  it('runs the script through the host and returns its result', async () => {
    const host = fakeHost({ evaluate: async (_id, script) => `ran:${script}` })
    const broker = await grantedBroker(host)
    const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

    const result = await broker.web.evaluate(APP, { id: context.id, script: 'location.origin' })

    expect(result).toBe('ran:location.origin')
  })

  it('is denied for an id this origin never held', async () => {
    const broker = await grantedBroker(fakeHost())
    await expect(broker.web.evaluate(APP, { id: 'not-a-real-id', script: '1' }))
      .rejects.toMatchObject({ code: 'denied' })
  })

  it('is denied for an id another origin holds -- unforgeable across origins (T11c)', async () => {
    const host = fakeHost()
    const broker = await grantedBroker(host)
    broker.registerApp('https://attacker.example', manifestWith({ web: { contexts: [CONTEXT_ORIGIN] } }))
    await broker.grant('https://attacker.example', 'web.context', [CONTEXT_ORIGIN])
    const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

    await expect(broker.web.evaluate('https://attacker.example', { id: context.id, script: '1' }))
      .rejects.toMatchObject({ code: 'denied' })
  })

  it('a raw throw from the host (the evaluated script itself throwing) rejects invalid, carrying the thrown message', async () => {
    const host = fakeHost({ evaluate: async () => { throw new Error('ReferenceError: x is not defined') } })
    const broker = await grantedBroker(host)
    const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

    await expect(broker.web.evaluate(APP, { id: context.id, script: 'x.y' }))
      .rejects.toMatchObject({ code: 'invalid', message: 'ReferenceError: x is not defined' })
  })

  it('rejects a script over LIMITS.webContextScriptBytes with limit', async () => {
    const broker = await grantedBroker(fakeHost())
    const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })
    const oversized = 'a'.repeat(LIMITS.webContextScriptBytes + 1)

    await expect(broker.web.evaluate(APP, { id: context.id, script: oversized }))
      .rejects.toMatchObject({ code: 'limit' })
  })

  it('rejects a result over LIMITS.webContextResultBytes with limit', async () => {
    const oversizedResult = 'x'.repeat(LIMITS.webContextResultBytes + 1)
    const host = fakeHost({ evaluate: async () => oversizedResult })
    const broker = await grantedBroker(host)
    const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

    await expect(broker.web.evaluate(APP, { id: context.id, script: '1' }))
      .rejects.toMatchObject({ code: 'limit' })
  })

  it('resolves a completion value of undefined as null, per contracts/handles.ts\'s own carve-out', async () => {
    const host = fakeHost({ evaluate: async () => undefined })
    const broker = await grantedBroker(host)
    const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

    await expect(broker.web.evaluate(APP, { id: context.id, script: '1' })).resolves.toBeNull()
  })

  // Electron's executeJavaScript hands back real, live V8 values via
  // structured clone, not JSON text (measured against Electron 44 -- see
  // ../policy/web-context-result.ts's own header) -- these are exactly the
  // shapes a real host can legitimately hand this file, not synthetic ones.
  it.each([
    ['NaN, which JSON.stringify would silently turn into null', NaN],
    ['Infinity', Infinity],
    ['a Date (a real instance after structured clone, not a string)', new Date(0)],
    ['a Map', new Map([['a', 1]])],
    ['undefined nested in an array', [undefined, 1]],
    ['undefined nested in an object', { a: undefined, b: 1 }],
    ['a function nested in an array', [1, () => {}]]
  ])('rejects invalid for %s rather than silently coercing or letting it through', async (_label, value) => {
    const host = fakeHost({ evaluate: async () => value })
    const broker = await grantedBroker(host)
    const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

    await expect(broker.web.evaluate(APP, { id: context.id, script: '1' }))
      .rejects.toMatchObject({ code: 'invalid' })
  })

  it('returns a JSON-compatible result unchanged', async () => {
    const value = { a: [1, 'x', true, null], b: {} }
    const host = fakeHost({ evaluate: async () => value })
    const broker = await grantedBroker(host)
    const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

    await expect(broker.web.evaluate(APP, { id: context.id, script: '1' })).resolves.toEqual(value)
  })

  it('rejects a second concurrent evaluate on the same context with limit, one-at-a-time', async () => {
    let releaseFirst: (() => void) | undefined
    const host = fakeHost({
      evaluate: async () => await new Promise((resolve) => { releaseFirst = () => { resolve('first') } })
    })
    const broker = await grantedBroker(host)
    const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

    const first = broker.web.evaluate(APP, { id: context.id, script: 'a' })
    // Give the first call a tick to register as in-flight before the second races it.
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    await expect(broker.web.evaluate(APP, { id: context.id, script: 'b' }))
      .rejects.toMatchObject({ code: 'limit' })

    releaseFirst?.()
    await expect(first).resolves.toBe('first')
  })

  it('times out after LIMITS.webContextEvaluateMs, without waiting for the host', async () => {
    vi.useFakeTimers()
    try {
      const host = fakeHost({ evaluate: async () => await new Promise(() => {}) })
      const broker = await grantedBroker(host)
      const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

      const pending = broker.web.evaluate(APP, { id: context.id, script: 'while(true){}' })
      const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(LIMITS.webContextEvaluateMs + 1)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('a timed-out evaluate closes the context: the handle is gone, a second evaluate rejects closed, and `closed` rejects timeout too', async () => {
    vi.useFakeTimers()
    try {
      const host = fakeHost({ evaluate: async () => await new Promise(() => {}) })
      const broker = await grantedBroker(host)
      const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

      // Registered BEFORE the timeout fires -- see WebContext.closed's own
      // doc note in ../web-capability.ts for why a timed-out evaluate
      // REJECTS `closed` (with 'timeout') rather than resolving it the way
      // an idle close does.
      const closedAssertion = expect(broker.web.awaitClose(APP, { id: context.id }))
        .rejects.toMatchObject({ code: 'timeout' })

      const pending = broker.web.evaluate(APP, { id: context.id, script: 'while(true){}' })
      const timeoutAssertion = expect(pending).rejects.toMatchObject({ code: 'timeout' })

      await vi.advanceTimersByTimeAsync(LIMITS.webContextEvaluateMs + 1)
      await timeoutAssertion
      await closedAssertion
      // The destroy callback's own `await host.close(hostId)` runs one
      // microtask hop after `closed` rejects (handle-store.ts's own
      // ordering: reject THEN teardown) -- let it settle before asserting
      // on the fake host's own side-effect.
      await Promise.resolve()

      expect(host.closed).toEqual(['host-1'])
      await expect(broker.web.evaluate(APP, { id: context.id, script: '1' }))
        .rejects.toMatchObject({ code: 'closed' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('WebContext.close (via orivon.web.close)', () => {
  it('closes the host context and is idempotent', async () => {
    const host = fakeHost()
    const broker = await grantedBroker(host)
    const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

    await broker.web.close(APP, { id: context.id })
    await broker.web.close(APP, { id: context.id }) // idempotent -- no throw

    expect(host.closed).toHaveLength(1)
  })

  it('is a silent no-op for an id this origin does not hold', async () => {
    const broker = await grantedBroker(fakeHost())
    await expect(broker.web.close(APP, { id: 'never-opened' })).resolves.toBeUndefined()
  })
})

describe('WebContext.closed (via orivon.web.awaitClose -- the live-push seam WebContext.closed needs)', () => {
  it('resolves once the app explicitly closes the context', async () => {
    const broker = await grantedBroker(fakeHost())
    const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

    const awaited = broker.web.awaitClose(APP, { id: context.id })
    await broker.web.close(APP, { id: context.id })

    await expect(awaited).resolves.toBeUndefined()
  })

  it('rejects with revoked once the grant is withdrawn', async () => {
    const broker = await grantedBroker(fakeHost())
    const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

    const awaited = broker.web.awaitClose(APP, { id: context.id })
    const grants = await broker.app.grants(APP)
    const webGrant = grants.find((g) => g.capability === 'web.context')
    if (webGrant === undefined) throw new Error('expected a live web.context grant')
    await broker.revoke(APP, webGrant.id)

    await expect(awaited).rejects.toMatchObject({ code: 'revoked' })
  })

  it('rejects immediately for an id this origin does not hold', async () => {
    const broker = await grantedBroker(fakeHost())
    await expect(broker.web.awaitClose(APP, { id: 'never-opened' })).rejects.toMatchObject({ code: 'denied' })
  })
})

describe('revocation follows the same mechanism as a net.connect socket', () => {
  it('revoking the web.context grant closes every open context for that origin, calling the host, and refuses a subsequent evaluate against it', async () => {
    const host = fakeHost()
    const broker = await grantedBroker(host)
    const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

    const grants = await broker.app.grants(APP)
    const webGrant = grants.find((g) => g.capability === 'web.context')
    expect(webGrant).toBeDefined()
    if (webGrant === undefined) return

    await broker.revoke(APP, webGrant.id)

    expect(host.closed).toContain('host-1')
    // 'closed', not 'denied' -- HandleTable.lookup's own uniform answer for
    // an id THIS ORIGIN held and has already closed (handle-store.ts's own
    // NOT_YOURS doc), exactly the same code a socket's own post-revoke read
    // gets. A truly unrecognised or foreign id still answers 'denied' -- see
    // the ownership tests above.
    await expect(broker.web.evaluate(APP, { id: context.id, script: '1' }))
      .rejects.toMatchObject({ code: 'closed' })
  })

  it('rejects a pending evaluate with revoked when the grant is withdrawn mid-call', async () => {
    let hostResolve: ((value: unknown) => void) | undefined
    const host = fakeHost({
      evaluate: async () => await new Promise((resolve) => { hostResolve = resolve })
    })
    const broker = await grantedBroker(host)
    const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

    const pending = broker.web.evaluate(APP, { id: context.id, script: 'slow()' })
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    const grants = await broker.app.grants(APP)
    const webGrant = grants.find((g) => g.capability === 'web.context')
    if (webGrant === undefined) throw new Error('expected a live web.context grant')
    await broker.revoke(APP, webGrant.id)

    await expect(pending).rejects.toMatchObject({ code: 'revoked' })
    hostResolve?.('too late')
  })
})

// Finding 3 of the security review: before this, a context's own renderer
// dying on its own (WebContextHost.onGone -- Electron's render-process-gone,
// wired up in src/main/web-context-host.ts) went unnoticed until
// LIMITS.webContextIdleMs closed it as merely idle. `host.simulateGone`
// stands in for the real host calling the listener it registered via
// `onGone`.
describe('a crashed context renderer (WebContextHost.onGone)', () => {
  it('fails the handle at once: `closed` rejects reset promptly, and a later evaluate rejects closed, not a generic error', async () => {
    const host = fakeHost()
    const broker = await grantedBroker(host)
    const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

    const closedAssertion = expect(broker.web.awaitClose(APP, { id: context.id }))
      .rejects.toMatchObject({ code: 'reset', platformCode: 'crashed' })

    host.simulateGone('host-1', 'crashed')
    await closedAssertion

    await expect(broker.web.evaluate(APP, { id: context.id, script: '1' }))
      .rejects.toMatchObject({ code: 'closed' })
  })

  it('rejects a pending evaluate with reset when the renderer dies mid-call', async () => {
    let hostResolve: ((value: unknown) => void) | undefined
    const host = fakeHost({
      evaluate: async () => await new Promise((resolve) => { hostResolve = resolve })
    })
    const broker = await grantedBroker(host)
    const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

    const pending = broker.web.evaluate(APP, { id: context.id, script: 'slow()' })
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    host.simulateGone('host-1', 'oom')

    await expect(pending).rejects.toMatchObject({ code: 'reset' })
    hostResolve?.('too late')
  })

  it('is a silent no-op if the reported hostId has no live bookkeeping -- already closed through another path', async () => {
    const host = fakeHost()
    const broker = await grantedBroker(host)
    const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })
    await broker.web.close(APP, { id: context.id })

    expect(() => { host.simulateGone('host-1', 'crashed') }).not.toThrow()
  })
})

describe('the idle timer (LIMITS.webContextIdleMs)', () => {
  it('closes an idle context on its own, resolving `closed` rather than rejecting it', async () => {
    vi.useFakeTimers()
    try {
      const host = fakeHost()
      const broker = await grantedBroker(host)
      await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

      await vi.advanceTimersByTimeAsync(LIMITS.webContextIdleMs + 1)

      expect(host.closed).toEqual(['host-1'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a context that keeps evaluating never idles out mid-call', async () => {
    vi.useFakeTimers()
    try {
      const host = fakeHost({ evaluate: async () => 'ok' })
      const broker = await grantedBroker(host)
      const context = await broker.web.openContext(APP, { origin: CONTEXT_ORIGIN })

      // Almost the whole idle budget, then a real evaluate call, which must
      // reset the timer rather than let it fire mid-flight.
      await vi.advanceTimersByTimeAsync(LIMITS.webContextIdleMs - 10)
      await broker.web.evaluate(APP, { id: context.id, script: '1' })
      await vi.advanceTimersByTimeAsync(20)

      expect(host.closed).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
