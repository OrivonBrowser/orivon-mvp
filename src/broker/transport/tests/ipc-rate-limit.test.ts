import { describe, expect, it, vi } from 'vitest'
import { handleControlRequest, registerBrokerIpc } from '../ipc.js'
import type { ControlEvent, IpcMainLike } from '../ipc.js'
import type { RateLimiter } from '../token-bucket.js'
import { createControlLimiter } from '../control-limiter.js'
import type { ControlLimiter } from '../control-limiter.js'
import type { RequestEnvelope, ResponseEnvelope } from '../../../contracts/ipc.js'
import { APP, type BrokerCall, envelope, frameFor, stubBroker } from './ipc.test-helpers.js'

// Proves open-questions.md A38's fix: a per-origin RateLimiter, checked in
// handleControlRequest BEFORE dispatch() runs, independent of and in
// addition to whatever the broker itself does. Kept separate from
// ipc.test.ts (near its own 800-line budget) per code-guidelines.md Rule 2.

/** A limiter whose every call returns `allow`, recording each origin it was asked about. */
function fixedLimiter (allow: boolean): RateLimiter & { readonly askedOrigins: string[] } {
  const askedOrigins: string[] = []
  return {
    tryConsume: (origin) => { askedOrigins.push(origin); return allow },
    askedOrigins
  }
}

const METHODS: ReadonlyArray<[string, unknown]> = [
  ['app.manifest', undefined],
  ['app.grants', undefined],
  ['fs.readFile', { path: '/a.txt' }],
  ['fs.writeFile', { path: '/a.txt', data: new Uint8Array() }],
  ['net.connect', { host: 'x.example', port: 443 }]
]

/** Calls on an already-open handle: bounded by their own, much larger budget instead of the control bucket. */
const HANDLE_IO: ReadonlyArray<[string, unknown]> = [
  ['fs.read', { id: 'h', position: 0, length: 1 }],
  ['fs.write', { id: 'h', position: 0, data: new Uint8Array(1) }],
  ['fs.fstat', { id: 'h' }],
  ['fs.truncate', { id: 'h', length: 0 }],
  ['fs.sync', { id: 'h' }],
  ['fs.close', { id: 'h' }],
  ['net.close', { id: 'h' }],
  ['net.setNoDelay', { id: 'h', on: true }],
  ['net.setKeepAlive', { id: 'h', on: true }]
]

/** A control bucket that is always empty, plus a handle budget answering `allowHandleIo`, recording which one each call reached. */
function splitLimiter (allowHandleIo: boolean): ControlLimiter & { readonly control: string[], readonly handleIo: string[] } {
  const control: string[] = []
  const handleIo: string[] = []
  return {
    tryConsume: (origin) => { control.push(origin); return false },
    admitHandleIo: async (origin) => { handleIo.push(origin); return allowHandleIo },
    control,
    handleIo
  }
}

describe('the rate limiter (open-questions.md A38)', () => {
  it('with no limiter argument, behaves exactly as before -- unaffected, not throttled', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { grants: async () => [] })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('app.grants', undefined))

    expect(response).toEqual({ id: 'req-1', ok: true, result: [] })
  })

  it('an exhausted limiter rejects with limit, without ever calling the broker', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { grants: async () => [] })
    const limiter = fixedLimiter(false)

    const response = await handleControlRequest(broker, frameFor(APP), envelope('app.grants', undefined), undefined, limiter)

    expect(response).toEqual({ id: 'req-1', ok: false, code: 'limit', message: expect.any(String) })
    expect(calls).toEqual([])
  })

  it('a limiter that allows the call lets dispatch proceed as normal', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { grants: async () => [] })
    const limiter = fixedLimiter(true)

    const response = await handleControlRequest(broker, frameFor(APP), envelope('app.grants', undefined), undefined, limiter)

    expect(response).toEqual({ id: 'req-1', ok: true, result: [] })
    expect(calls).toEqual([{ method: 'app.grants', origin: APP, args: undefined }])
  })

  // MUTATION TEST: an implementation that checked the limiter against
  // something from the payload (or skipped deriving the origin first) would
  // ask the limiter about the wrong string, or ask before the null-frame
  // 'denied' check ran. Asserting the EXACT origin the limiter saw catches
  // both.
  it('the limiter is asked about the DERIVED origin, never anything from the payload', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { readFile: async () => new Uint8Array() })
    const limiter = fixedLimiter(true)
    const hostilePayload = { path: '/f.txt', origin: 'https://attacker.example' }

    await handleControlRequest(broker, frameFor(APP), envelope('fs.readFile', hostilePayload), undefined, limiter)

    expect(limiter.askedOrigins).toEqual([APP])
  })

  it('a null senderFrame is denied before the limiter is ever consulted', async () => {
    const calls: BrokerCall[] = []
    const limiter = fixedLimiter(true)

    const response = await handleControlRequest(
      stubBroker(calls), { senderFrame: null }, envelope('app.grants', undefined), undefined, limiter
    )

    expect(response).toMatchObject({ ok: false, code: 'denied' })
    expect(limiter.askedOrigins).toEqual([])
  })

  it.each(METHODS)('%s is rejected with limit when the bucket is exhausted -- no exemption', async (method, payload) => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls)
    const limiter = fixedLimiter(false)

    const response = await handleControlRequest(broker, frameFor(APP), envelope(method, payload), undefined, limiter)

    expect(response).toMatchObject({ ok: false, code: 'limit' })
    expect(calls).toEqual([])
  })

  it('registerBrokerIpc threads the limiter through to the real registered handler', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { grants: async () => [] })
    const registered = new Map<string, (event: ControlEvent, envelope: RequestEnvelope<unknown>) => Promise<ResponseEnvelope<unknown>>>()
    const fakeIpcMain: IpcMainLike = { handle: (channel, listener) => { registered.set(channel, listener) } }
    const fakeTransport = { createPortPair: (): never => { throw new Error('not needed for this test') }, registry: { register: vi.fn(), get: vi.fn(), remove: vi.fn() } }
    const limiter = fixedLimiter(false)

    registerBrokerIpc(fakeIpcMain, broker, fakeTransport, limiter)
    const listener = registered.get('orivon:control')
    const response = await listener?.(frameFor(APP), envelope('app.grants', undefined))

    expect(response).toMatchObject({ ok: false, code: 'limit' })
    expect(calls).toEqual([])
  })

  it.each(HANDLE_IO)('%s draws on the handle budget and never spends a control token', async (method, payload) => {
    const calls: BrokerCall[] = []
    const limiter = splitLimiter(true)

    const response = await handleControlRequest(stubBroker(calls), frameFor(APP), envelope(method, payload), undefined, limiter)

    expect(response).not.toMatchObject({ code: 'limit' })
    expect(limiter.handleIo).toEqual([APP])
    expect(limiter.control).toEqual([])
  })

  it.each(HANDLE_IO)('%s is refused with limit once the handle budget refuses', async (method, payload) => {
    const calls: BrokerCall[] = []
    const limiter = splitLimiter(false)

    const response = await handleControlRequest(stubBroker(calls), frameFor(APP), envelope(method, payload), undefined, limiter)

    expect(response).toMatchObject({ ok: false, code: 'limit' })
    expect(calls).toEqual([])
  })

  it('a control call never draws on the handle budget', async () => {
    const calls: BrokerCall[] = []
    const limiter = splitLimiter(true)

    await handleControlRequest(stubBroker(calls, { grants: async () => [] }), frameFor(APP), envelope('app.grants', undefined), undefined, limiter)

    expect(limiter.control).toEqual([APP])
    expect(limiter.handleIo).toEqual([])
  })

  // The failure this split exists for: a database streaming one fs.write per
  // record exhausted the shared bucket, and every later call -- its own
  // writes and any net.connect -- answered 'limit'.
  it('with the production limiter, a burst of handle I/O leaves the control budget untouched', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { grants: async () => [] })
    const limiter = createControlLimiter(() => 0)

    for (let i = 0; i < 1_000; i++) {
      const response = await handleControlRequest(broker, frameFor(APP), envelope('fs.close', { id: `h${i}` }), undefined, limiter)
      expect(response).not.toMatchObject({ code: 'limit' })
    }
    const control = await handleControlRequest(broker, frameFor(APP), envelope('app.grants', undefined), undefined, limiter)

    expect(control).toEqual({ id: 'req-1', ok: true, result: [] })
  })
})
