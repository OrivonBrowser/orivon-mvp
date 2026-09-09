import { describe, expect, it, vi } from 'vitest'
import { rejection } from '../handles/tests/handles.test-helpers.js'
import { APP, baseDeps, manifestWith, okListenedServer } from './index.test-helpers.js'
import { createBroker } from '../index.js'
import { fail } from '../errors.js'
import type { Broker, DialedSocket, Listen } from '../broker-contracts.js'

// `orivon.net.listen` at the assembly layer -- the same job index-udp.test.ts
// does for udpBind, and the same idea: the GRANTED set decides, never the
// manifest's declared one. checkBind itself (policy/tests/bind.test.ts) and
// the handle table's tcpServer/acquireDerived cascade
// (handles/tests/handles.test.ts, handles-limits.test.ts) are both already
// fully covered elsewhere -- this file is only about the ASSEMBLY: does
// `listen()` call the adapter with the checked ranges, build a FailableTcpServer
// correctly, and route an accepted connection through the handle table.
//
// A real accepted connection over a real socket, and the full revocation
// cascade against one, are covered separately in
// adapters/tests/node-adapters.test.ts, against the real `listenTcp` adapter
// -- this file uses a stub `ListenedServer` throughout.

const DECLARED = { net: { tcp: { listen: ['30000-30010'] } } }

/** A broker with `tcp.listen` granted over 30000-30010 and nothing else. */
async function listeningBroker (deps = baseDeps()): Promise<Broker> {
  const broker = createBroker(deps)
  broker.registerApp(APP, manifestWith(DECLARED))
  await broker.grant(APP, 'tcp.listen', ['30000-30010'])
  return broker
}

/** A DialedSocket-shaped accepted connection -- readable/writable are never read from in these tests. */
function okAccepted (overrides: Partial<DialedSocket> = {}): DialedSocket {
  return {
    readable: new ReadableStream(),
    writable: new WritableStream(),
    remoteAddress: '203.0.113.9',
    remotePort: 54321,
    localAddress: '0.0.0.0',
    localPort: 30005,
    setNoDelay: async () => {},
    setKeepAlive: async () => {},
    destroy: vi.fn(),
    ...overrides
  }
}

describe('listen -- the grant ledger decides', () => {
  it('denies when tcp.listen was never granted, however broadly the manifest declares it', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith(DECLARED))

    const error = await rejection(broker.net.listen(APP, { port: 30000 }))

    expect(error.code).toBe('denied')
    // A denial never says why (contracts/errors.ts) -- a platformCode here
    // would leak whether the port or the grant was the problem.
    expect(error.platformCode).toBeUndefined()
  })

  it('denies a port outside the granted range', async () => {
    const broker = await listeningBroker()
    const error = await rejection(broker.net.listen(APP, { port: 9999 }))
    expect(error.code).toBe('denied')
  })

  it('listens on a port inside the granted range and returns a live server handle', async () => {
    const broker = await listeningBroker(baseDeps({ listen: async () => okListenedServer({ localPort: 30007 }) }))
    const server = await broker.net.listen(APP, { port: 30005 })

    expect(server.id).toEqual(expect.any(String))
    expect(server.localPort).toBe(30007)
    expect(server.localAddress).toBe('0.0.0.0')
    expect(typeof server.close).toBe('function')
  })

  it('hands the adapter the CHECKED range, never the raw port', async () => {
    const listen = vi.fn<Listen>(async () => okListenedServer())
    const broker = await listeningBroker(baseDeps({ listen }))

    await broker.net.listen(APP, { port: 30005 })

    expect(listen).toHaveBeenCalledWith([{ lo: 30005, hi: 30005 }], expect.anything())
  })

  it('hands the adapter every granted range for an ephemeral listen (port 0)', async () => {
    const listen = vi.fn<Listen>(async () => okListenedServer())
    const broker = await listeningBroker(baseDeps({ listen }))

    await broker.net.listen(APP, { port: 0 })

    expect(listen).toHaveBeenCalledWith([{ lo: 30000, hi: 30010 }], expect.anything())
  })

  it('tears the listener down rather than leaking it when the grant is revoked mid-listen', async () => {
    const destroy = vi.fn()
    let revoke = (): void => {}
    const listen: Listen = async () => {
      revoke()
      return okListenedServer({ destroy })
    }
    const broker = await listeningBroker(baseDeps({ listen }))
    const [grant] = await broker.app.grants(APP)
    revoke = () => { void broker.revoke(APP, grant!.id) }

    await rejection(broker.net.listen(APP, { port: 30000 }))

    expect(destroy).toHaveBeenCalledWith('revoked')
  })
})

describe('listen -- accepted connections become derived handles', () => {
  it('a read on connections calls accept() and yields a handle for the accepted socket', async () => {
    const accept = vi.fn(async () => okAccepted())
    const broker = await listeningBroker(baseDeps({ listen: async () => okListenedServer({ accept }) }))
    const server = await broker.net.listen(APP, { port: 30000 })

    const { value: socket, done } = await server.connections.getReader().read()

    expect(done).toBe(false)
    expect(socket?.id).toEqual(expect.any(String))
    expect(socket?.id).not.toBe(server.id)
    expect(socket?.remoteAddress).toBe('203.0.113.9')
    expect(accept).toHaveBeenCalledTimes(1)
  })

  it('does not call accept() before the app reads -- no pre-accepting ahead of demand', async () => {
    const accept = vi.fn(async () => await new Promise<never>(() => {}))
    const broker = await listeningBroker(baseDeps({ listen: async () => okListenedServer({ accept }) }))
    await broker.net.listen(APP, { port: 30000 })

    // A macrotask, so any eager pull() the ReadableStream might have queued
    // on its own has had a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(accept).not.toHaveBeenCalled()
  })

  it('a graceful end (accept() resolving null) closes the connections stream, not errors it', async () => {
    const broker = await listeningBroker(baseDeps({ listen: async () => okListenedServer({ accept: async () => null }) }))
    const server = await broker.net.listen(APP, { port: 30000 })

    const { done } = await server.connections.getReader().read()

    expect(done).toBe(true)
  })

  it('an abrupt accept() rejection errors the connections stream with the same code', async () => {
    // ListenedServer.accept's own contract: it rejects with an already-shaped
    // OrivonError for an abrupt reason (../broker-contracts.ts) -- mapIoError
    // passes one through unchanged rather than re-mapping it, so the stub
    // must throw a real one, not a plain Error with a `.code` string.
    const broker = await listeningBroker(baseDeps({
      listen: async () => okListenedServer({
        accept: async () => { throw fail('revoked', 'the grant authorising this listen was withdrawn') }
      })
    }))
    const server = await broker.net.listen(APP, { port: 30000 })

    await expect(server.connections.getReader().read()).rejects.toMatchObject({ code: 'revoked' })
  })

  it('revoking the server grant tears down an already-accepted connection too', async () => {
    const acceptedDestroy = vi.fn()
    const accepted = okAccepted({ destroy: acceptedDestroy })
    const broker = await listeningBroker(baseDeps({ listen: async () => okListenedServer({ accept: async () => accepted }) }))
    const server = await broker.net.listen(APP, { port: 30000 })
    await server.connections.getReader().read()

    const [grant] = await broker.app.grants(APP)
    await broker.revoke(APP, grant!.id)

    expect(acceptedDestroy).toHaveBeenCalledWith('revoked')
  })
})
