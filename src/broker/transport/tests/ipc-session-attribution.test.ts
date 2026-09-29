import { describe, expect, it } from 'vitest'
import { handleControlRequest } from '../ipc.js'
import type { RequestGrantCtx } from '../ipc.js'
import {
  APP, APP_SESSION, DEFAULT_SESSION, envelope, frameFor, OTHER, stubBroker, subframeFor
} from './ipc.test-helpers.js'

// Split out of ipc.test.ts (already near Rule 2's budget), matching
// ipc-request-grant.test.ts's own precedent. Proves the session half of
// origin attribution: a frame's claimed origin is not enough on its own --
// the WebContents making the call must also be the top frame (never a
// subframe or a guest speaking for it), and it must sit in whatever
// Electron session that origin's own documents belong in. `sessionForOrigin`
// is the injected answer to the second question; every test here builds its
// own, standing in for what a granted origin's real partition would be.

/** `origin` belongs in `APP_SESSION` once `granted` is true, `DEFAULT_SESSION`
 * otherwise -- a granted origin's own session answer changes the instant
 * `broker.grant()` resolves, which is exactly what lets the reload tests
 * below simulate a document that just won its first capability. */
function sessionRule (granted: () => boolean): (origin: string) => unknown {
  return (origin) => (origin === APP && granted()) ? APP_SESSION : DEFAULT_SESSION
}

describe('session-bound attribution', () => {
  it('denies a call whose sender sits in the default session when its origin belongs in an isolated one', async () => {
    const response = await handleControlRequest(
      stubBroker([]), frameFor(APP, DEFAULT_SESSION), envelope('app.manifest', undefined),
      undefined, undefined, undefined, undefined, sessionRule(() => true)
    )

    expect(response).toMatchObject({ ok: false, code: 'denied' })
  })

  it('allows a call whose sender already sits in the session its origin belongs in', async () => {
    const calls: Array<{ method: string }> = []
    const broker = stubBroker([], { manifest: async () => { calls.push({ method: 'app.manifest' }); return { orivonApiVersion: 0, id: APP, name: 'App', version: '1.0.0', entry: 'index.html', capabilities: {} } } })

    const response = await handleControlRequest(
      broker, frameFor(APP, APP_SESSION), envelope('app.manifest', undefined),
      undefined, undefined, undefined, undefined, sessionRule(() => true)
    )

    expect(response.ok).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('allows an ungranted origin whose sender sits in the default session, which is where it belongs', async () => {
    const response = await handleControlRequest(
      stubBroker([], { grants: async () => [] }), frameFor(OTHER, DEFAULT_SESSION), envelope('app.grants', undefined),
      undefined, undefined, undefined, undefined, sessionRule(() => false)
    )

    expect(response.ok).toBe(true)
  })

  it('denies a subframe speaking for its top frame\'s origin, even from the right session (embed guests and web contexts)', async () => {
    const response = await handleControlRequest(
      stubBroker([]), subframeFor(APP, APP_SESSION), envelope('app.manifest', undefined),
      undefined, undefined, undefined, undefined, sessionRule(() => true)
    )

    expect(response).toMatchObject({ ok: false, code: 'denied' })
  })

  it('never checks the session when no sessionForOrigin is injected, matching every other suite\'s call shape', async () => {
    const response = await handleControlRequest(
      stubBroker([], { grants: async () => [] }), frameFor(APP, DEFAULT_SESSION), envelope('app.grants', undefined)
    )

    expect(response.ok).toBe(true)
  })
})

describe('app.requestGrant moves the calling document once it changes which session its origin belongs in', () => {
  function fakeCtx (result: boolean, onCalled: () => void): RequestGrantCtx {
    return { requestGrant: async () => { onCalled(); return result } }
  }

  it('reloads the sender once a grant moves its origin out of the default session', async () => {
    let granted = false
    const ctx = fakeCtx(true, () => { granted = true })
    const event = frameFor(APP, DEFAULT_SESSION)

    const response = await handleControlRequest(
      stubBroker([]), event, envelope('app.requestGrant', { capability: 'fs' }),
      undefined, undefined, ctx, undefined, sessionRule(() => granted)
    )

    expect(response).toEqual({ id: 'req-1', ok: true, result: true })
    expect(event.sender.reload).toHaveBeenCalledOnce()
  })

  it('does not reload when the request was declined -- nothing moved', async () => {
    const ctx = fakeCtx(false, () => {})
    const event = frameFor(APP, DEFAULT_SESSION)

    await handleControlRequest(
      stubBroker([]), event, envelope('app.requestGrant', { capability: 'fs' }),
      undefined, undefined, ctx, undefined, sessionRule(() => false)
    )

    expect(event.sender.reload).not.toHaveBeenCalled()
  })

  it('does not reload when the sender already sits in the session the newly granted origin belongs in', async () => {
    const ctx = fakeCtx(true, () => {})
    const event = frameFor(APP, APP_SESSION)

    await handleControlRequest(
      stubBroker([]), event, envelope('app.requestGrant', { capability: 'fs' }),
      undefined, undefined, ctx, undefined, sessionRule(() => true)
    )

    expect(event.sender.reload).not.toHaveBeenCalled()
  })

  it('does not reload a sender that was already destroyed by the time the grant settled', async () => {
    let granted = false
    const ctx = fakeCtx(true, () => { granted = true })
    const event = frameFor(APP, DEFAULT_SESSION)
    event.sender.isDestroyed = () => true

    await handleControlRequest(
      stubBroker([]), event, envelope('app.requestGrant', { capability: 'fs' }),
      undefined, undefined, ctx, undefined, sessionRule(() => granted)
    )

    expect(event.sender.reload).not.toHaveBeenCalled()
  })

  it('does not reload for any method other than app.requestGrant, even one that changes the session answer as a side effect', async () => {
    let granted = false
    const event = frameFor(APP, DEFAULT_SESSION)
    // Attribution passes here (sessionRule still answers DEFAULT_SESSION),
    // then this call's own handler flips it -- standing in for whatever
    // unrelated state change a method besides app.requestGrant could never
    // legitimately cause, so the reload check must stay keyed to the METHOD,
    // not to "did the answer change".
    const broker = stubBroker([], { grants: async () => { granted = true; return [] } })

    await handleControlRequest(
      broker, event, envelope('app.grants', undefined),
      undefined, undefined, undefined, undefined, sessionRule(() => granted)
    )

    expect(event.sender.reload).not.toHaveBeenCalled()
  })
})
