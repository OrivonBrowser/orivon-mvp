// web.openContext / web.evaluate / web.close's control-channel wiring
// (ADR-0019), split into its own sibling file rather than grown onto
// ./ipc.test.ts (752/800 lines already, the same reason ./ipc-net-lookup.
// test.ts exists as its own sibling instead of growing that file). Covers
// handleControlRequest's routing and payload validation only -- the
// authorisation, revocation, limits and timeout behaviour itself is
// ../../tests/web-capability.test.ts's job, against a real broker.

import { describe, expect, it } from 'vitest'
import { handleControlRequest } from '../ipc.js'
import type { BrokerCall } from './ipc.test-helpers.js'
import { APP, envelope, frameFor, stubBroker } from './ipc.test-helpers.js'

describe('web.openContext', () => {
  it('dispatches to broker.web.openContext with the sender-frame origin and the context origin', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      webOpenContext: async () => ({ id: 'ctx-1', origin: 'https://example.com' })
    })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('web.openContext', { origin: 'https://example.com' }))

    expect(response).toEqual({ id: 'req-1', ok: true, result: { id: 'ctx-1', origin: 'https://example.com' } })
    expect(calls).toEqual([{ method: 'web.openContext', origin: APP, args: { origin: 'https://example.com' } }])
  })

  it('passes width/height through only when the caller actually sent them (exactOptionalPropertyTypes)', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      webOpenContext: async () => ({ id: 'ctx-1', origin: 'https://example.com' })
    })

    await handleControlRequest(broker, frameFor(APP), envelope('web.openContext', { origin: 'https://example.com', width: 800, height: 600 }))

    expect(calls).toEqual([{ method: 'web.openContext', origin: APP, args: { origin: 'https://example.com', width: 800, height: 600 } }])
  })

  it('rejects a payload missing origin as invalid, without reaching the broker', async () => {
    const calls: BrokerCall[] = []
    const response = await handleControlRequest(stubBroker(calls), frameFor(APP), envelope('web.openContext', {}))

    expect(response).toEqual({ id: 'req-1', ok: false, code: 'invalid', message: expect.any(String) })
    expect(calls).toEqual([])
  })

  it('rejects a non-string origin as invalid, without reaching the broker', async () => {
    const calls: BrokerCall[] = []
    const response = await handleControlRequest(stubBroker(calls), frameFor(APP), envelope('web.openContext', { origin: 42 }))

    expect(response).toEqual({ id: 'req-1', ok: false, code: 'invalid', message: expect.any(String) })
    expect(calls).toEqual([])
  })

  it('rejects a non-numeric width as invalid, without reaching the broker', async () => {
    const calls: BrokerCall[] = []
    const response = await handleControlRequest(
      stubBroker(calls), frameFor(APP), envelope('web.openContext', { origin: 'https://example.com', width: 'wide' })
    )

    expect(response).toEqual({ id: 'req-1', ok: false, code: 'invalid', message: expect.any(String) })
    expect(calls).toEqual([])
  })

  // The two ways a denial must be indistinguishable to the caller (ADR-0019,
  // item 6 of the spec): whichever one broker.web.openContext threw, it
  // crosses the wire as the same closed enum, with no platformCode -- proven
  // at the broker level (web-capability.test.ts); this proves the transport
  // does not add one back in on the way through.
  it('crosses a broker denial as the closed enum, with no platformCode', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      webOpenContext: async () => { throw Object.assign(new Error('web.context is not granted to this origin for the requested context origin'), { code: 'denied' }) }
    })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('web.openContext', { origin: 'https://example.com' }))

    expect(response).toEqual({
      id: 'req-1',
      ok: false,
      code: 'denied',
      message: 'web.context is not granted to this origin for the requested context origin'
    })
    expect(response).not.toHaveProperty('platformCode')
  })
})

describe('web.evaluate', () => {
  it('dispatches to broker.web.evaluate with the sender-frame origin, the handle id and the script', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { webEvaluate: async () => 'https://example.com' })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('web.evaluate', { id: 'ctx-1', script: 'location.origin' }))

    expect(response).toEqual({ id: 'req-1', ok: true, result: 'https://example.com' })
    expect(calls).toEqual([{ method: 'web.evaluate', origin: APP, args: { id: 'ctx-1', script: 'location.origin' } }])
  })

  it('rejects a payload missing script as invalid, without reaching the broker', async () => {
    const calls: BrokerCall[] = []
    const response = await handleControlRequest(stubBroker(calls), frameFor(APP), envelope('web.evaluate', { id: 'ctx-1' }))

    expect(response).toEqual({ id: 'req-1', ok: false, code: 'invalid', message: expect.any(String) })
    expect(calls).toEqual([])
  })

  it('rejects a payload missing id as invalid, without reaching the broker', async () => {
    const calls: BrokerCall[] = []
    const response = await handleControlRequest(stubBroker(calls), frameFor(APP), envelope('web.evaluate', { script: '1' }))

    expect(response).toEqual({ id: 'req-1', ok: false, code: 'invalid', message: expect.any(String) })
    expect(calls).toEqual([])
  })
})

describe('web.close', () => {
  it('dispatches to broker.web.close with the sender-frame origin and the handle id, replying with no result', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { webClose: async () => {} })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('web.close', { id: 'ctx-1' }))

    expect(response).toEqual({ id: 'req-1', ok: true, result: undefined })
    expect(calls).toEqual([{ method: 'web.close', origin: APP, args: { id: 'ctx-1' } }])
  })

  it('rejects a payload missing id as invalid, without reaching the broker', async () => {
    const calls: BrokerCall[] = []
    const response = await handleControlRequest(stubBroker(calls), frameFor(APP), envelope('web.close', {}))

    expect(response).toEqual({ id: 'req-1', ok: false, code: 'invalid', message: expect.any(String) })
    expect(calls).toEqual([])
  })
})
