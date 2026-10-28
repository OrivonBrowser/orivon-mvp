// What a WASI program holds in the broker once it drops a socket. The host runs against the REAL broker's handle
// table (only the dial and the peer are faked), through the real Worker-to-page transfer, because the leak was in
// the count the broker keeps: a program that drops sockets must leave the origin's census near zero, however far
// each socket had got. This test imports the broker, which the shim's own code never may: the census is the
// broker's, and the only way to read it is to ask it.

import { afterEach, describe, expect, it } from 'vitest'
import { APP, brokerWithConnectGrant, okSocket } from '../../../broker/tests/index.test-helpers.js'
import type { Broker, CreateBrokerOptions, DialedSocket } from '../../../broker/broker-contracts.js'
import { createOrivonClient } from '../../worker/orivon-client.js'
import { type OrivonServer, serveOrivon } from '../../worker/orivon-server.js'
import type { IpSocketAddress, SocketNet } from '../addresses.js'
import type { OutputStream } from '../io.js'
import { socketInterfaces } from '../sockets.js'
import type { TcpSocket } from '../tcp.js'

const PEER: IpSocketAddress = { tag: 'ipv4', val: { port: 443, address: [93, 184, 216, 34] } }

let server: OrivonServer | undefined
let channel: MessageChannel | undefined

afterEach(async () => {
  await server?.dispose()
  channel?.port2.close()
  server = undefined
})

/** A dial that answers only when told to, and rejects the way the real one does when its signal aborts. */
function slowDial (): { dial: CreateBrokerOptions['dial'], answerAll: () => void, started: () => number } {
  const waiting: Array<() => void> = []
  let started = 0
  return {
    dial: async (_addresses, _port, signal) => await new Promise<DialedSocket>((resolve, reject) => {
      started += 1
      signal.addEventListener('abort', () => { reject(Object.assign(new Error('the dial was abandoned'), { code: 'ECANCELED' })) }, { once: true })
      waiting.push(() => { resolve(okSocket()) })
    }),
    answerAll: () => { for (const answer of waiting.splice(0)) answer() },
    started: () => started
  }
}

/** The program's side: wasi:sockets over the broker's `orivon.net` for APP, as the Worker reaches it. */
function programOver (broker: Broker, dropGraceMs = 50): { create: () => TcpSocket } {
  channel = new MessageChannel()
  server = serveOrivon(channel.port1, { net: { connect: async (opts: never) => await broker.net.connect(APP, opts) } })
  const net = (createOrivonClient(channel.port2) as { net: SocketNet }).net
  const interfaces = socketInterfaces(net, { dropGraceMs })
  const create = (interfaces['wasi:sockets/tcp-create-socket'] as { createTcpSocket: (family: string) => TcpSocket }).createTcpSocket
  return { create: () => create('ipv4') }
}

async function until (condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  if (!condition()) throw new Error(`gave up waiting for ${what}`)
}

describe('a program that drops sockets leaves the origin holding nothing', () => {
  it('releases a dial the program dropped before it finished, at once', async () => {
    const dials = slowDial()
    const broker = await brokerWithConnectGrant({ dial: dials.dial })
    const program = programOver(broker)

    const sockets = Array.from({ length: 40 }, () => program.create())
    for (const socket of sockets) socket.startConnect({}, PEER)
    await until(() => dials.started() === sockets.length, 'every dial to start')
    expect(broker.app.socketUsageSync(APP).inFlight).toBe(sockets.length)

    for (const socket of sockets) socket[Symbol.dispose]()

    await until(() => broker.app.socketUsageSync(APP).inFlight === 0, 'the abandoned dials to free their slots')
    dials.answerAll()
    expect(broker.app.socketUsageSync(APP)).toMatchObject({ open: 0, inFlight: 0 })
  })

  it('releases a socket the program wrote to and dropped while its peer stays silent', async () => {
    // The peer never ends its side, as a host that accepts a connection and then says nothing does.
    const broker = await brokerWithConnectGrant({ dial: async () => okSocket() })
    const program = programOver(broker)

    const sockets = Array.from({ length: 12 }, () => program.create())
    for (const socket of sockets) socket.startConnect({}, PEER)
    for (const socket of sockets) await socket.subscribe().block()
    const outputs = sockets.map((socket) => socket.finishConnect()[1] as OutputStream)
    expect(broker.app.socketUsageSync(APP).open).toBe(sockets.length)

    for (const output of outputs) await output.blockingWriteAndFlush(new TextEncoder().encode('/multistream/1.0.0\n'))
    for (const socket of sockets) socket[Symbol.dispose]()

    await until(() => broker.app.socketUsageSync(APP).open === 0, 'the dropped sockets to leave the census')
  })

  it('still releases a socket the program never wrote to, one whose connect failed, and one it dropped before finishing the connect', async () => {
    let calls = 0
    const broker = await brokerWithConnectGrant({
      dial: async () => {
        calls += 1
        if (calls === 2) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
        return okSocket()
      }
    })
    const program = programOver(broker)
    const quiet = program.create()
    const failed = program.create()
    const unfinished = program.create()
    quiet.startConnect({}, PEER)
    await quiet.subscribe().block()
    quiet.finishConnect()
    failed.startConnect({}, PEER)
    await failed.subscribe().block()
    expect(() => failed.finishConnect()).toThrow('connection-refused')
    unfinished.startConnect({}, PEER)
    await unfinished.subscribe().block()
    expect(broker.app.socketUsageSync(APP).open).toBe(2)

    quiet[Symbol.dispose]()
    failed[Symbol.dispose]()
    unfinished[Symbol.dispose]()

    await until(() => broker.app.socketUsageSync(APP).open === 0, 'the sockets to leave the census')
  })
})
