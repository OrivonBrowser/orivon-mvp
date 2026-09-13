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
    const fakeTransport = { createPortPair: (): never => { throw new Error('not needed for this test') }, registry: { register: vi.fn(), get: vi.fn(), remove: vi.fn() } }
    const { ctx, calls } = fakeCtx()

    registerBrokerIpc(fakeIpcMain, stubBroker([]), fakeTransport, undefined, ctx)
    const listener = registered.get(CONTROL_CHANNEL)
    const response = await listener?.(frameFor(APP), envelope('app.requestGrant', { capability: 'fs' }))

    expect(response).toEqual({ id: 'req-1', ok: true, result: true })
    expect(calls).toEqual([{ origin: APP, request: { capability: 'fs' } }])
  })
})
