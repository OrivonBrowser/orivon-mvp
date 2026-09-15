// net.lookup's control-channel wiring, split into its own sibling file
// rather than grown onto ./ipc.test.ts (752/800 lines already -- adding here
// would have pushed it toward Rule 2's own limit, the same reason
// ./net-connect-secure.test.ts and friends exist as siblings of
// ../../tests/index.test.ts). Covers handleControlRequest's routing and
// payload validation only -- the authorisation and revocation behaviour
// itself is ../../tests/net-lookup.test.ts's job, against a real broker.

import { describe, expect, it } from 'vitest'
import { handleControlRequest } from '../ipc.js'
import type { BrokerCall } from './ipc.test-helpers.js'
import { APP, envelope, frameFor, stubBroker } from './ipc.test-helpers.js'

describe('net.lookup (no port transport -- a plain request/response, unlike net.connect)', () => {
  it('dispatches to broker.net.lookup with the sender-frame origin and the requested hostname', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      lookup: async () => [{ address: '93.184.216.34', family: 'IPv4' }]
    })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('net.lookup', { hostname: 'api.example.com' }))

    expect(response).toEqual({ id: 'req-1', ok: true, result: [{ address: '93.184.216.34', family: 'IPv4' }] })
    expect(calls).toEqual([{ method: 'net.lookup', origin: APP, args: { hostname: 'api.example.com' } }])
  })

  it('rejects a payload missing hostname as invalid, without reaching the broker', async () => {
    const calls: BrokerCall[] = []
    const response = await handleControlRequest(stubBroker(calls), frameFor(APP), envelope('net.lookup', {}))

    expect(response).toEqual({ id: 'req-1', ok: false, code: 'invalid', message: expect.any(String) })
    expect(calls).toEqual([])
  })

  it('rejects a non-string hostname as invalid, without reaching the broker', async () => {
    const calls: BrokerCall[] = []
    const response = await handleControlRequest(stubBroker(calls), frameFor(APP), envelope('net.lookup', { hostname: 42 }))

    expect(response).toEqual({ id: 'req-1', ok: false, code: 'invalid', message: expect.any(String) })
    expect(calls).toEqual([])
  })

  it('crosses a broker denial as the closed enum, with no platformCode', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      lookup: async () => { throw Object.assign(new Error('the hostname was not authorised'), { code: 'denied' }) }
    })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('net.lookup', { hostname: 'evil.example' }))

    expect(response).toEqual({ id: 'req-1', ok: false, code: 'denied', message: 'the hostname was not authorised' })
    expect(response).not.toHaveProperty('platformCode')
  })
})
