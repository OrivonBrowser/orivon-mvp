import { describe, expect, it } from 'vitest'
import { handleControlRequest } from '../ipc.js'
import type { RequestGrantCtx } from '../ipc.js'
import {
  APP, APP_SESSION, attributedFrom, DEFAULT_SESSION, envelope, frameFor, OTHER, stubBroker, subframeFor
} from './ipc.test-helpers.js'

// Split out of ipc.test.ts (already near Rule 2's budget), matching
// ipc-request-grant.test.ts's own precedent. Proves the session half of
// origin attribution: a frame's claimed origin is not enough on its own --
// the WebContents making the call must also be the top frame (never a
// subframe or a guest speaking for it), and the injected `attributed`
// predicate must agree it belongs to that origin. `attributedFrom` stands
// in for what the real predicate's live-check fallback would answer; the
// record-based and cache-served branches are session-attribution.ts's own
// unit tests, not this file's.

/** `origin` belongs in `APP_SESSION` once `granted` is true, `DEFAULT_SESSION`
 * otherwise -- a granted origin's own session answer changes the instant
 * `broker.grant()` resolves. */
function sessionRule (granted: () => boolean): (origin: string) => unknown {
  return (origin) => (origin === APP && granted()) ? APP_SESSION : DEFAULT_SESSION
}

describe('session-bound attribution', () => {
  it('denies a call whose sender sits in the default session when its origin belongs in an isolated one', async () => {
    const response = await handleControlRequest(
      stubBroker([]), frameFor(APP, DEFAULT_SESSION), envelope('app.manifest', undefined),
      undefined, undefined, undefined, undefined, attributedFrom(sessionRule(() => true))
    )

    expect(response).toMatchObject({ ok: false, code: 'denied' })
  })

  it('allows a call whose sender already sits in the session its origin belongs in', async () => {
    const calls: Array<{ method: string }> = []
    const broker = stubBroker([], { manifest: async () => { calls.push({ method: 'app.manifest' }); return { orivonApiVersion: 0, id: APP, name: 'App', version: '1.0.0', entry: 'index.html', capabilities: {} } } })

    const response = await handleControlRequest(
      broker, frameFor(APP, APP_SESSION), envelope('app.manifest', undefined),
      undefined, undefined, undefined, undefined, attributedFrom(sessionRule(() => true))
    )

    expect(response.ok).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('allows an ungranted origin whose sender sits in the default session, which is where it belongs', async () => {
    const response = await handleControlRequest(
      stubBroker([], { grants: async () => [] }), frameFor(OTHER, DEFAULT_SESSION), envelope('app.grants', undefined),
      undefined, undefined, undefined, undefined, attributedFrom(sessionRule(() => false))
    )

    expect(response.ok).toBe(true)
  })

  it('denies a subframe speaking for its top frame\'s origin, even from the right session (embed guests and web contexts)', async () => {
    const response = await handleControlRequest(
      stubBroker([]), subframeFor(APP, APP_SESSION), envelope('app.manifest', undefined),
      undefined, undefined, undefined, undefined, attributedFrom(sessionRule(() => true))
    )

    expect(response).toMatchObject({ ok: false, code: 'denied' })
  })

  it('never checks attribution when no predicate is injected, matching every other suite\'s call shape', async () => {
    const response = await handleControlRequest(
      stubBroker([], { grants: async () => [] }), frameFor(APP, DEFAULT_SESSION), envelope('app.grants', undefined)
    )

    expect(response.ok).toBe(true)
  })
})

// The reload defect.ts's redesign removed: app.requestGrant no longer
// reloads the calling document. Attribution is decided when a document
// commits (src/main/sessions/session-attribution.ts), so a document that
// asked and won stays attributed through its own reply and every call
// after it, and moves session only on its next navigation.
describe('app.requestGrant never reloads the calling document', () => {
  function fakeCtx (result: boolean): RequestGrantCtx {
    return { requestGrant: async () => result }
  }

  it('does not reload the sender after a successful grant, even though it is the call that moves its origin to a new session', async () => {
    const ctx = fakeCtx(true)
    const event = frameFor(APP, DEFAULT_SESSION)
    // Attribution stays true throughout: this document already committed
    // in DEFAULT_SESSION, so it stays attributed regardless of what the
    // grant that just landed changes the LIVE expectation to -- there is no
    // live re-check left to trigger a reload from.
    const attributed = attributedFrom(() => DEFAULT_SESSION)

    const response = await handleControlRequest(
      stubBroker([]), event, envelope('app.requestGrant', { capability: 'fs' }),
      undefined, undefined, ctx, undefined, attributed
    )

    expect(response).toEqual({ id: 'req-1', ok: true, result: true })
    expect(event.sender.reload).not.toHaveBeenCalled()
  })

  it('does not reload when the request was declined either', async () => {
    const ctx = fakeCtx(false)
    const event = frameFor(APP, DEFAULT_SESSION)

    await handleControlRequest(
      stubBroker([]), event, envelope('app.requestGrant', { capability: 'fs' }),
      undefined, undefined, ctx, undefined, attributedFrom(() => DEFAULT_SESSION)
    )

    expect(event.sender.reload).not.toHaveBeenCalled()
  })
})
