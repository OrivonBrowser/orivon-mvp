import { describe, expect, it, vi } from 'vitest'
import { rejection } from '../handles/tests/handles.test-helpers.js'
import { APP, baseDeps, manifestWith, okSecureSocket, okSocket } from './index.test-helpers.js'
import { createBroker } from '../index.js'
import type { Broker, CreateBrokerOptions } from '../broker-contracts.js'

// A loopback grant reaches the person's own services, never the loopback
// listeners Orivon runs itself (the verifier, held local nodes, route fronts):
// those are kept from pages by the webRequest gate, which an orivon.net socket
// never passes through, so the broker refuses them where it decides.

const OWN_PORT = 23456
const OTHER_PORT = 23457
const RANGE = '20000-32767'
const ownLoopbackPort: NonNullable<CreateBrokerOptions['ownLoopbackPort']> = (port) => port === OWN_PORT

async function brokerWith (deps: Partial<CreateBrokerOptions>): Promise<Broker> {
  const broker = createBroker(baseDeps(deps))
  const patterns = [`127.0.0.1:${RANGE}`, `[::1]:${RANGE}`, `localhost:${RANGE}`, `0.0.0.0:${RANGE}`]
  broker.registerApp(APP, manifestWith({ net: { tcp: { connect: patterns }, https: { connect: [`localhost:${RANGE}`, `127.0.0.1:${RANGE}`] } } }))
  await broker.grant(APP, 'tcp.connect', patterns)
  await broker.grant(APP, 'https.connect', [`localhost:${RANGE}`, `127.0.0.1:${RANGE}`])
  return broker
}

describe('orivon.net.connect and connectSecure keep apps off Orivon\'s own loopback ports', () => {
  it.each(['127.0.0.1', '::1', 'localhost'])('refuses %s on a held port even though the loopback grant covers it, and dials nothing', async (host) => {
    const dial = vi.fn(async () => okSocket())
    const broker = await brokerWith({ dial, ownLoopbackPort })

    const error = await rejection(broker.net.connect(APP, { host, port: OWN_PORT }))

    expect(error.code).toBe('denied')
    expect(error.platformCode).toBeUndefined()
    expect(dial).not.toHaveBeenCalled()
  })

  it.each(['127.0.0.1', '::1', 'localhost'])('still reaches %s on another loopback port', async (host) => {
    const dial = vi.fn(async () => okSocket())
    const broker = await brokerWith({ dial, ownLoopbackPort })

    const socket = await broker.net.connect(APP, { host, port: OTHER_PORT })

    expect(socket.id).toEqual(expect.any(String))
    expect(dial).toHaveBeenCalledTimes(1)
  })

  it.each(['127.0.0.1', 'localhost'])('connectSecure refuses %s on a held port and reaches another', async (host) => {
    const dialSecure = vi.fn(async () => okSecureSocket())
    const broker = await brokerWith({ dialSecure, ownLoopbackPort })

    const error = await rejection(broker.net.connectSecure(APP, { host, port: OWN_PORT, rejectUnauthorized: false }))
    expect(error.code).toBe('denied')
    expect(dialSecure).not.toHaveBeenCalled()

    await broker.net.connectSecure(APP, { host, port: OTHER_PORT, rejectUnauthorized: false })
    expect(dialSecure).toHaveBeenCalledTimes(1)
  })

  it('a held port on a public address is an ordinary connect: the rule is about this machine', async () => {
    const dial = vi.fn(async () => okSocket())
    const broker = createBroker(baseDeps({ dial, ownLoopbackPort }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: [`93.184.216.34:${String(OWN_PORT)}`] } } }))
    await broker.grant(APP, 'tcp.connect', [`93.184.216.34:${String(OWN_PORT)}`])

    await broker.net.connect(APP, { host: '93.184.216.34', port: OWN_PORT })

    expect(dial).toHaveBeenCalledTimes(1)
  })

  it('reads the held ports live: a port held after the broker was built is refused from then on', async () => {
    const held = new Set<number>()
    const broker = await brokerWith({ ownLoopbackPort: (port) => held.has(port) })

    await broker.net.connect(APP, { host: '127.0.0.1', port: OWN_PORT })
    held.add(OWN_PORT)

    expect((await rejection(broker.net.connect(APP, { host: '127.0.0.1', port: OWN_PORT }))).code).toBe('denied')
  })
})
