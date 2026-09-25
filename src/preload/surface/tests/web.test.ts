import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// surface/web.ts imports `ipcRenderer` directly from 'electron' at module
// scope (via control-call.ts) -- mocked the same minimal way orivon-
// surface.test.ts mocks it for its own `ipcRenderer.invoke`-driven suites,
// without that file's heavier contextBridge/socket-bridge stack, which
// orivon.web never touches.
const invoke = vi.fn()

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: (...args: unknown[]) => invoke(...args),
    on: vi.fn(),
    sendSync: vi.fn()
  }
}))

const { webOpenContextBridge } = await import('../web.js')

function okEnvelope (result: unknown): { id: string, ok: true, result: unknown } {
  return { id: 'r', ok: true, result }
}

function failEnvelope (code: string, message = 'failed'): { id: string, ok: false, code: string, message: string } {
  return { id: 'r', ok: false, code, message }
}

beforeEach(() => {
  invoke.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('webOpenContextBridge', () => {
  it('calls web.openContext with the requested origin and no width/height when omitted', async () => {
    invoke.mockResolvedValueOnce(okEnvelope({ id: 'ctx-1', origin: 'https://example.com' }))
    // The watch loop's own first call -- never resolved in this test, so it
    // stays pending and never interferes with the assertions below.
    invoke.mockReturnValueOnce(new Promise(() => {}))

    const context = await webOpenContextBridge({ origin: 'https://example.com' })

    expect(context.id).toBe('ctx-1')
    expect(context.origin).toBe('https://example.com')
    const [, envelope] = invoke.mock.calls[0] as [string, { method: string, payload: unknown }]
    expect(envelope.method).toBe('web.openContext')
    expect(envelope.payload).toEqual({ origin: 'https://example.com' })
  })

  it('includes width/height only when the caller actually passed them (exactOptionalPropertyTypes)', async () => {
    invoke.mockResolvedValueOnce(okEnvelope({ id: 'ctx-1', origin: 'https://example.com' }))
    invoke.mockReturnValueOnce(new Promise(() => {}))

    await webOpenContextBridge({ origin: 'https://example.com', width: 800, height: 600 })

    const [, envelope] = invoke.mock.calls[0] as [string, { payload: unknown }]
    expect(envelope.payload).toEqual({ origin: 'https://example.com', width: 800, height: 600 })
  })

  it('evaluate calls web.evaluate with the context id and script, returning the result', async () => {
    invoke.mockResolvedValueOnce(okEnvelope({ id: 'ctx-1', origin: 'https://example.com' }))
    invoke.mockReturnValueOnce(new Promise(() => {})) // the watch loop
    invoke.mockResolvedValueOnce(okEnvelope('https://example.com'))

    const context = await webOpenContextBridge({ origin: 'https://example.com' })
    const result = await context.evaluate('location.origin')

    expect(result).toBe('https://example.com')
    const [, envelope] = invoke.mock.calls[2] as [string, { method: string, payload: unknown }]
    expect(envelope.method).toBe('web.evaluate')
    expect(envelope.payload).toEqual({ id: 'ctx-1', script: 'location.origin' })
  })

  it('evaluate passes a per-call timeoutMs to the broker, which enforces it', async () => {
    invoke.mockResolvedValueOnce(okEnvelope({ id: 'ctx-1', origin: 'https://example.com' }))
    invoke.mockReturnValueOnce(new Promise(() => {})) // the watch loop
    invoke.mockResolvedValueOnce(okEnvelope(null))

    const context = await webOpenContextBridge({ origin: 'https://example.com' })
    await context.evaluate('1', { timeoutMs: 2_000 })

    const [, envelope] = invoke.mock.calls[2] as [string, { payload: unknown }]
    expect(envelope.payload).toEqual({ id: 'ctx-1', script: '1', timeoutMs: 2_000 })
  })

  it('close calls web.close with the context id', async () => {
    invoke.mockResolvedValueOnce(okEnvelope({ id: 'ctx-1', origin: 'https://example.com' }))
    invoke.mockReturnValueOnce(new Promise(() => {})) // the watch loop
    invoke.mockResolvedValueOnce(okEnvelope(undefined))

    const context = await webOpenContextBridge({ origin: 'https://example.com' })
    await context.close()

    const [, envelope] = invoke.mock.calls[2] as [string, { method: string, payload: unknown }]
    expect(envelope.method).toBe('web.close')
    expect(envelope.payload).toEqual({ id: 'ctx-1' })
  })

  it('closed resolves once web.awaitClose resolves', async () => {
    invoke.mockResolvedValueOnce(okEnvelope({ id: 'ctx-1', origin: 'https://example.com' }))
    invoke.mockResolvedValueOnce(okEnvelope(undefined))

    const context = await webOpenContextBridge({ origin: 'https://example.com' })

    await expect(context.closed).resolves.toBeUndefined()
    const [, envelope] = invoke.mock.calls[1] as [string, { method: string, payload: unknown }]
    expect(envelope.method).toBe('web.awaitClose')
    expect(envelope.payload).toEqual({ id: 'ctx-1' })
  })

  it('closed rejects with the real OrivonError when web.awaitClose reports the grant was revoked', async () => {
    invoke.mockResolvedValueOnce(okEnvelope({ id: 'ctx-1', origin: 'https://example.com' }))
    invoke.mockResolvedValueOnce(failEnvelope('revoked', 'the grant authorising this context was withdrawn'))

    const context = await webOpenContextBridge({ origin: 'https://example.com' })

    await expect(context.closed).rejects.toMatchObject({ code: 'revoked', name: 'OrivonError' })
  })

  // THE LOOP ITSELF: a LOCAL transport-level timeout (control-call.ts's own
  // raceTimeout, never a real broker answer -- web.awaitClose does not time
  // out on its own) must not surface as `closed` rejecting -- it means
  // "poll again", and the SECOND call settling for real is what `closed`
  // actually reflects.
  it('re-issues web.awaitClose after a local transport timeout, rather than treating it as the final answer', async () => {
    vi.useFakeTimers()
    try {
      invoke.mockResolvedValueOnce(okEnvelope({ id: 'ctx-1', origin: 'https://example.com' }))
      // First awaitClose call: never settles on its own -- raceTimeout's own
      // timer must be what ends it.
      invoke.mockReturnValueOnce(new Promise(() => {}))
      // Second awaitClose call, issued by the loop after the first "timed
      // out" locally: resolves for real.
      invoke.mockResolvedValueOnce(okEnvelope(undefined))

      const context = await webOpenContextBridge({ origin: 'https://example.com' })
      const assertion = expect(context.closed).resolves.toBeUndefined()

      // Past TIMEOUT_MS.webAwaitClose (LIMITS.webContextIdleMs + 5_000).
      await vi.advanceTimersByTimeAsync(310_000)
      await assertion

      expect(invoke).toHaveBeenCalledTimes(3) // openContext + two awaitClose attempts
    } finally {
      vi.useRealTimers()
    }
  })
})
