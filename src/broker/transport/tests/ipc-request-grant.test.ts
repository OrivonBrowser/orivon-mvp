import { describe, expect, it, vi } from 'vitest'
import { CONTROL_CHANNEL, handleControlRequest, registerBrokerIpc } from '../ipc.js'
import type { ControlEvent, IpcMainLike, RequestGrantCtx } from '../ipc.js'
import { MAX_PATTERNS } from '../../policy/connect.js'
import type { RequestEnvelope, ResponseEnvelope } from '../../../contracts/ipc.js'
import { APP, type BrokerCall, envelope, frameFor, stubBroker } from './ipc.test-helpers.js'

// app.requestGrant's control-channel case (compatibility-matrix.md Table 4
// row 1) -- the first page-facing caller of ../../main/request-grant.ts's
// mechanism. Split out of ipc.test.ts, already at Rule 2's budget, matching
// ipc-fs.test.ts's and ipc-udp.test.ts's own precedent for a whole control
// method landing after that file was already near the cap.
//
// THIS FILE PROVES DISPATCH ONLY: that handleControlRequest derives the
// origin from the sender frame (never the payload, T3), validates the
// payload shape, and forwards to whatever requestGrantCtx.requestGrant
// closure it was given. What that closure actually decides (manifest
// narrowing, consent, broker.grant()) is main/tests/request-grant.test.ts's
// job against the real implementation.

function fakeCtx (requestGrant?: RequestGrantCtx['requestGrant']): { ctx: RequestGrantCtx, calls: Array<{ origin: string, request: unknown }> } {
  const calls: Array<{ origin: string, request: unknown }> = []
  return {
    calls,
    ctx: {
      requestGrant: requestGrant ?? (async (origin: string, request: unknown) => { calls.push({ origin, request }); return true })
    }
  }
}

describe('app.requestGrant', () => {
  it('forwards the derived origin and the validated payload to requestGrantCtx.requestGrant', async () => {
    const { ctx, calls } = fakeCtx()

    const response = await handleControlRequest(
      stubBroker([]), frameFor(APP), envelope('app.requestGrant', { capability: 'tcp.connect', patterns: ['*:443'] }),
      undefined, undefined, ctx
    )

    expect(response).toEqual({ id: 'req-1', ok: true, result: true })
    expect(calls).toEqual([{ origin: APP, request: { capability: 'tcp.connect', patterns: ['*:443'] } }])
  })

  it('works with patterns omitted -- "whatever the manifest already declares" (request-grant.ts\'s own contract)', async () => {
    const { ctx, calls } = fakeCtx()

    await handleControlRequest(stubBroker([]), frameFor(APP), envelope('app.requestGrant', { capability: 'fs' }), undefined, undefined, ctx)

    expect(calls).toEqual([{ origin: APP, request: { capability: 'fs' } }])
  })

  it('resolves whatever requestGrantCtx.requestGrant resolves, including false', async () => {
    const { ctx } = fakeCtx(async () => false)

    const response = await handleControlRequest(stubBroker([]), frameFor(APP), envelope('app.requestGrant', { capability: 'fs' }), undefined, undefined, ctx)

    expect(response).toEqual({ id: 'req-1', ok: true, result: false })
  })

  it('never forwards anything from the payload beyond capability/patterns, even one naming its own origin (T3)', async () => {
    const { ctx, calls } = fakeCtx()
    const hostilePayload = { capability: 'fs', origin: 'https://attacker.example', extra: 'field' }

    await handleControlRequest(stubBroker([]), frameFor(APP), envelope('app.requestGrant', hostilePayload), undefined, undefined, ctx)

    expect(calls).toEqual([{ origin: APP, request: { capability: 'fs' } }])
  })

  it('never calls the broker directly -- main/request-grant.ts owns that seam, not this dispatch case', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls)
    const { ctx } = fakeCtx()

    await handleControlRequest(broker, frameFor(APP), envelope('app.requestGrant', { capability: 'fs' }), undefined, undefined, ctx)

    expect(calls).toEqual([])
  })

  describe('rejects a malformed payload as invalid, without calling requestGrantCtx', () => {
    it.each<[string, unknown]>([
      ['missing capability', {}],
      ['capability not a string', { capability: 42 }],
      ['patterns not an array', { capability: 'fs', patterns: 'not-an-array' }],
      ['a pattern that is not a string', { capability: 'fs', patterns: ['ok', 42] }],
      ['more patterns than MAX_PATTERNS allows (A119)', { capability: 'fs', patterns: Array.from({ length: MAX_PATTERNS + 1 }, () => '*:*') }]
    ])('%s', async (_label, payload) => {
      const { ctx, calls } = fakeCtx()

      const response = await handleControlRequest(stubBroker([]), frameFor(APP), envelope('app.requestGrant', payload), undefined, undefined, ctx)

      expect(response).toMatchObject({ ok: false, code: 'invalid' })
      expect(calls).toEqual([])
    })
  })

  it('fails closed as an internal error when no requestGrantCtx was configured for this broker (a wiring bug, not a capability decision)', async () => {
    const response = await handleControlRequest(stubBroker([]), frameFor(APP), envelope('app.requestGrant', { capability: 'fs' }))

    expect(response).toMatchObject({ ok: false, code: 'internal' })
  })

  it('fails closed as an internal error when requestGrantCtx.requestGrant is itself undefined (the subsystem has not published yet, or failed to start)', async () => {
    const response = await handleControlRequest(
      stubBroker([]), frameFor(APP), envelope('app.requestGrant', { capability: 'fs' }), undefined, undefined, { requestGrant: undefined }
    )

    expect(response).toMatchObject({ ok: false, code: 'internal' })
  })

  it('registerBrokerIpc threads requestGrantCtx through to the real registered handler', async () => {
    const registered = new Map<string, (event: ControlEvent, envelope: RequestEnvelope<unknown>) => Promise<ResponseEnvelope<unknown>>>()
    const fakeIpcMain: IpcMainLike = { handle: (channel, listener) => { registered.set(channel, listener) } }
    const fakeTransport = { createPortPair: (): never => { throw new Error('not needed for this test') }, registry: { register: vi.fn(), get: vi.fn(), remove: vi.fn() }, dials: { begin: vi.fn(), cancel: vi.fn() } }
    const { ctx, calls } = fakeCtx()

    registerBrokerIpc(fakeIpcMain, stubBroker([]), fakeTransport, undefined, ctx)
    const listener = registered.get(CONTROL_CHANNEL)
    const response = await listener?.(frameFor(APP), envelope('app.requestGrant', { capability: 'fs' }))

    expect(response).toEqual({ id: 'req-1', ok: true, result: true })
    expect(calls).toEqual([{ origin: APP, request: { capability: 'fs' } }])
  })
})

// Task 1(a): the dialog this dispatch case leads to is parented to the
// calling tab's window and knows whether that tab is still on the origin
// that asked -- both built here, from the real sending frame, so
// main/consent/request-grant.ts's own logic never has to reach into
// Electron to answer either question.
describe('app.requestGrant builds a DialogCaller from the real sending frame', () => {
  function fakeCtxCapturingCaller (): { ctx: RequestGrantCtx, caller: () => { window: () => unknown, stillOn: (origin: string) => boolean } | undefined } {
    let captured: { window: () => unknown, stillOn: (origin: string) => boolean } | undefined
    return {
      caller: () => captured,
      ctx: {
        requestGrant: async (_origin: string, _request: unknown, caller: { window: () => unknown, stillOn: (origin: string) => boolean }) => {
          captured = caller
          return true
        }
      }
    }
  }

  it('contents() is the sending tab itself, so the question is drawn in that tab\'s own panel', async () => {
    let contents: (() => unknown) | undefined
    const ctx: RequestGrantCtx = {
      requestGrant: async (_origin, _request, caller) => { contents = caller.contents; return true }
    }
    const event = frameFor(APP)

    await handleControlRequest(stubBroker([]), event, envelope('app.requestGrant', { capability: 'fs' }), undefined, undefined, ctx)

    expect(contents?.()).toBe(event.sender)
  })

  it('stillOn(origin) is true while the sender is alive and still on that origin', async () => {
    const { ctx, caller } = fakeCtxCapturingCaller()

    await handleControlRequest(stubBroker([]), frameFor(APP), envelope('app.requestGrant', { capability: 'fs' }), undefined, undefined, ctx)

    expect(caller()?.stillOn(APP)).toBe(true)
  })

  it('stillOn(origin) is false once the sender is destroyed', async () => {
    const { ctx, caller } = fakeCtxCapturingCaller()
    const event: ControlEvent = frameFor(APP)
    const destroyedEvent: ControlEvent = { ...event, sender: { ...event.sender, isDestroyed: () => true } }

    await handleControlRequest(stubBroker([]), destroyedEvent, envelope('app.requestGrant', { capability: 'fs' }), undefined, undefined, ctx)

    expect(caller()?.stillOn(APP)).toBe(false)
  })

  it('stillOn(origin) is false for an origin other than the one the sender\'s top frame is now on -- read LIVE, not captured', async () => {
    const { ctx, caller } = fakeCtxCapturingCaller()
    const OTHER = 'https://other.example'
    const event: ControlEvent = frameFor(APP)

    // The origin for THIS call is derived from the frame as it was when the
    // request arrived -- APP.
    await handleControlRequest(stubBroker([]), event, envelope('app.requestGrant', { capability: 'fs' }), undefined, undefined, ctx)

    // The frame navigates AFTER that -- exactly what a page could do while
    // `app.requestGrant`'s own dialog is still up (A153) -- and `stillOn`
    // reads it live, never a value captured when the request arrived.
    Object.assign(event.sender.mainFrame as object, { url: `${OTHER}/`, origin: OTHER })

    expect(caller()?.stillOn(APP)).toBe(false)
    expect(caller()?.stillOn(OTHER)).toBe(true)
  })

  it('window() resolves through the injected windowForSender, given the real sender', async () => {
    const { ctx, caller } = fakeCtxCapturingCaller()
    const event = frameFor(APP)
    const fakeWindow = { id: 'the-tabs-window' }
    const windowForSender = vi.fn((sender: unknown) => sender === event.sender ? fakeWindow : undefined)

    await handleControlRequest(
      stubBroker([]), event, envelope('app.requestGrant', { capability: 'fs' }), undefined, undefined, ctx, undefined, undefined, windowForSender
    )

    expect(caller()?.window()).toBe(fakeWindow)
  })

  it('window() is undefined when no windowForSender is injected', async () => {
    const { ctx, caller } = fakeCtxCapturingCaller()

    await handleControlRequest(stubBroker([]), frameFor(APP), envelope('app.requestGrant', { capability: 'fs' }), undefined, undefined, ctx)

    expect(caller()?.window()).toBeUndefined()
  })
})
