import { describe, expect, it } from 'vitest'
import { handleControlRequest } from '../ipc.js'
import { isNetUdpBindParams } from '../ipc-validation.js'
import {
  APP, envelope, fakeMultiTransport, fakePortPair, fakeTcpServer, fakeTransport, fakeUdpSocket, frameFor, stubBroker, tick
} from './ipc.test-helpers.js'
import type { BrokerCall } from './ipc.test-helpers.js'

// The optional `scope` (ADR-0034) of `net.listen` and `net.udpBind` on the
// control channel: exactly 'local', 'network' or absent reaches the broker;
// anything else is refused here as 'invalid', before the broker is called.

async function listenWith (payload: unknown): Promise<{ calls: BrokerCall[], result: unknown }> {
  const calls: BrokerCall[] = []
  const broker = stubBroker(calls, { listen: async () => fakeTcpServer().server })
  const result = await handleControlRequest(broker, frameFor(APP), envelope('net.listen', payload), fakeMultiTransport())
  await tick()
  return { calls, result }
}

async function bindWith (payload: unknown): Promise<{ calls: BrokerCall[], result: unknown }> {
  const calls: BrokerCall[] = []
  const broker = stubBroker(calls, { udpBind: async () => fakeUdpSocket(new ReadableStream()).socket })
  const { pair } = fakePortPair()
  const result = await handleControlRequest(broker, frameFor(APP), envelope('net.udpBind', payload), fakeTransport(pair))
  await tick()
  return { calls, result }
}

const BAD_SCOPES = ['lan', 'LOCAL', 'Network', '', ' local', null, 0, 1, true, {}, ['local']]

describe.each([
  { method: 'net.listen', run: listenWith },
  { method: 'net.udpBind', run: bindWith }
])('$method -- the scope on the wire', ({ method, run }) => {
  it.each(['local', 'network'] as const)('carries scope %s to the broker', async (scope) => {
    const { calls, result } = await run({ port: 4001, scope })
    expect(result).toMatchObject({ ok: true })
    expect(calls).toContainEqual({ method, origin: APP, args: { port: 4001, scope } })
  })

  it('leaves scope out of the broker call when the app omitted it, so the broker applies its own default', async () => {
    const { calls } = await run({ port: 4001 })
    expect(calls).toContainEqual({ method, origin: APP, args: { port: 4001 } })
  })

  it('treats an explicit undefined as omitted', async () => {
    const { calls } = await run({ port: 4001, scope: undefined })
    expect(calls).toContainEqual({ method, origin: APP, args: { port: 4001 } })
  })

  it.each(BAD_SCOPES)('refuses scope %j as invalid without calling the broker', async (scope) => {
    const { calls, result } = await run({ port: 4001, scope })
    expect(result).toMatchObject({ ok: false, code: 'invalid' })
    expect(calls).toHaveLength(0)
  })
})

describe('isNetUdpBindParams', () => {
  it('still requires a port in range whatever the scope', () => {
    expect(isNetUdpBindParams({ scope: 'local' })).toBe(false)
    expect(isNetUdpBindParams({ port: 70000, scope: 'local' })).toBe(false)
    expect(isNetUdpBindParams({ port: 0, scope: 'network' })).toBe(true)
  })
})
