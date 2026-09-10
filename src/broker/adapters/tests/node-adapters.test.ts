import { connect as netConnect, createServer, type Server, type Socket } from 'node:net'
import { createBroker } from '../../index.js'
import { afterEach, describe, expect, it } from 'vitest'
import { dialTcp, listenTcp, nodeFs, resolveHost } from '../node-adapters.js'

// nodeFs's own suite (the BrokerFs real-filesystem adapter) moved to
// ./node-fs-adapter.test.ts, paired with ../node-fs-adapter.ts's own split
// out of ../node-adapters.ts (code-guidelines.md Rule 2). `nodeFs` is still
// imported here -- 'net.listen end to end' below still needs one as a
// throwaway BrokerFs to satisfy createBroker's fixed dependency shape.

/** A once-only AbortController's signal -- dialTcp/dialOne need one, and none of these tests abort mid-dial. */
function neverAborts (): AbortSignal {
  return new AbortController().signal
}

describe('resolveHost (real DNS)', () => {
  it('resolves loopback without touching a real resolver', async () => {
    const addresses = await resolveHost('localhost')

    expect(addresses.length).toBeGreaterThan(0)
  })

  // NOT TESTED: a genuine DNS failure mapping to 'unreachable'. Checked
  // empirically first (writing-good-tests.md's own rule) rather than
  // assumed: `node:dns.lookup('this-host-does-not-exist.invalid', ...)`
  // resolves to 127.0.0.1 with no error at all in this sandbox's network
  // environment, so a real unresolvable-host test would be asserting on
  // this machine's resolver quirks, not on resolveHost's own logic, and
  // would silently pass or fail depending on where CI happens to run it.
  // The mapping itself (any dns.lookup rejection -> 'unreachable',
  // errno preserved as platformCode) is a single straight-line branch,
  // covered indirectly wherever a real dial fails end-to-end.
})

describe('dialTcp / dialOne against a real local TCP server', () => {
  let server: Server
  let port: number
  let acceptedSockets: Socket[]

  function listen (): Promise<void> {
    acceptedSockets = []
    server = createServer((socket) => { acceptedSockets.push(socket) })
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        port = typeof address === 'object' && address !== null ? address.port : 0
        resolve()
      })
    })
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
  })

  /** Waits for the server to have accepted at least one connection. */
  async function firstAccepted (): Promise<Socket> {
    for (let i = 0; i < 100 && acceptedSockets.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const socket = acceptedSockets[0]
    if (socket === undefined) throw new Error('server never accepted a connection')
    return socket
  }

  it('connects to a real listening socket and exposes the resolved addresses', async () => {
    await listen()

    const dialed = await dialTcp(['127.0.0.1'], port, neverAborts())

    expect(dialed.remoteAddress).toBe('127.0.0.1')
    expect(dialed.remotePort).toBe(port)
    await dialed.destroy('closed')
  })

  it("destroy('closed') sends a clean FIN -- the peer sees a graceful end, not an error", async () => {
    await listen()
    const dialed = await dialTcp(['127.0.0.1'], port, neverAborts())
    const peer = await firstAccepted()
    const peerEnded = new Promise<void>((resolve) => peer.once('end', resolve))
    const peerErrored = new Promise<Error>((resolve) => peer.once('error', resolve))

    await dialed.destroy('closed')

    const winner = await Promise.race([peerEnded.then(() => 'end'), peerErrored.then(() => 'error')])
    expect(winner).toBe('end')
  })

  it("destroy('sessionEnded') also sends a clean FIN, same as 'closed'", async () => {
    await listen()
    const dialed = await dialTcp(['127.0.0.1'], port, neverAborts())
    const peer = await firstAccepted()
    const peerEnded = new Promise<void>((resolve) => peer.once('end', resolve))
    const peerErrored = new Promise<Error>((resolve) => peer.once('error', resolve))

    await dialed.destroy('sessionEnded')

    const winner = await Promise.race([peerEnded.then(() => 'end'), peerErrored.then(() => 'error')])
    expect(winner).toBe('end')
  })

  it("destroy('revoked') resets the connection -- the peer sees ECONNRESET, not a graceful end", async () => {
    await listen()
    const dialed = await dialTcp(['127.0.0.1'], port, neverAborts())
    const peer = await firstAccepted()
    const peerErrored = new Promise<NodeJS.ErrnoException>((resolve) => peer.once('error', resolve))

    await dialed.destroy('revoked')

    const error = await peerErrored
    expect(error.code).toBe('ECONNRESET')
  })

  it("destroy('aborted') also resets the connection, same as 'revoked' -- the app chose to discard a still-live socket", async () => {
    await listen()
    const dialed = await dialTcp(['127.0.0.1'], port, neverAborts())
    const peer = await firstAccepted()
    const peerErrored = new Promise<NodeJS.ErrnoException>((resolve) => peer.once('error', resolve))

    await dialed.destroy('aborted')

    const error = await peerErrored
    expect(error.code).toBe('ECONNRESET')
  })

  it("destroy('failed') releases the local socket without waiting on a FIN handshake", async () => {
    await listen()
    const dialed = await dialTcp(['127.0.0.1'], port, neverAborts())

    // 'failed' means the resource is already gone -- release the fd, touch
    // the wire not at all (handle-contracts.ts's own CloseReason doc). A
    // real .end()-based FIN waits for the 'finish'/callback event, which is
    // exactly what this reason must NOT do -- so this resolving promptly is
    // itself the behavioural difference from 'closed' worth asserting.
    await dialed.destroy('failed')
  })
})


/** Connects a real client socket to `port` and waits for it to establish. */
async function connectClient (port: number): Promise<Socket> {
  const client = netConnect({ host: '127.0.0.1', port })
  await new Promise<void>((resolve, reject) => {
    client.once('connect', resolve)
    client.once('error', reject)
  })
  return client
}

describe('listenTcp against a real TCP client', () => {
  it('binds inside the granted range and reports the real bound port', async () => {
    const listened = await listenTcp([{ lo: 30000, hi: 30010 }], neverAborts())

    expect(listened.localPort).toBeGreaterThanOrEqual(30000)
    expect(listened.localPort).toBeLessThanOrEqual(30010)
    expect(listened.localAddress).toBe('0.0.0.0')

    await listened.destroy('closed')
  })

  it('accept() resolves with a real connection once a client connects', async () => {
    const listened = await listenTcp([{ lo: 30000, hi: 30010 }], neverAborts())
    const acceptPromise = listened.accept()

    const client = await connectClient(listened.localPort)
    const accepted = await acceptPromise

    expect(accepted).not.toBeNull()
    expect(accepted?.remoteAddress).toBe('127.0.0.1')

    client.destroy()
    await accepted?.destroy('closed')
    await listened.destroy('closed')
  })

  it('a second accept() waits until a second client connects -- no pre-accepting ahead of demand', async () => {
    const listened = await listenTcp([{ lo: 30000, hi: 30010 }], neverAborts())

    const first = await (async () => {
      const p = listened.accept()
      const client = await connectClient(listened.localPort)
      const accepted = await p
      return { client, accepted }
    })()

    let secondSettled = false
    const secondPromise = listened.accept().then((value) => { secondSettled = true; return value })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(secondSettled).toBe(false)

    const secondClient = await connectClient(listened.localPort)
    const second = await secondPromise
    expect(second).not.toBeNull()

    first.client.destroy()
    secondClient.destroy()
    await first.accepted?.destroy('closed')
    await second?.destroy('closed')
    await listened.destroy('closed')
  })

  it("destroy('closed') ends the server gracefully -- a still-pending accept() resolves null, not an error", async () => {
    const listened = await listenTcp([{ lo: 30000, hi: 30010 }], neverAborts())
    const pending = listened.accept()

    await listened.destroy('closed')

    expect(await pending).toBeNull()
  })

  it("destroy('revoked') rejects a still-pending accept() with 'revoked', not a silent null", async () => {
    const listened = await listenTcp([{ lo: 30000, hi: 30010 }], neverAborts())
    const pending = listened.accept()

    await listened.destroy('revoked')

    await expect(pending).rejects.toMatchObject({ code: 'revoked' })
  })

  it('destroy() resets every accepted-but-unclaimed connection still queued', async () => {
    const listened = await listenTcp([{ lo: 30000, hi: 30010 }], neverAborts())
    const client = await connectClient(listened.localPort)
    const clientErrored = new Promise<NodeJS.ErrnoException>((resolve) => client.once('error', resolve))
    // Give the server's 'connection' handler a tick to run and queue it --
    // nothing has called accept() yet, so it lands in the internal queue.
    await new Promise((resolve) => setTimeout(resolve, 20))

    await listened.destroy('revoked')

    const error = await clientErrored
    expect(error.code).toBe('ECONNRESET')
  })

  it('rejects a listen with no free port in the granted range', async () => {
    const first = await listenTcp([{ lo: 30020, hi: 30020 }], neverAborts())

    await expect(listenTcp([{ lo: 30020, hi: 30020 }], neverAborts())).rejects.toMatchObject({ code: 'limit' })

    await first.destroy('closed')
  })
})

describe('net.listen end to end: a real accepted connection, a real denial, a real revocation cascade', () => {
  // The lane's own exit criterion (unattended-build-queue.md item 2.4), pinned
  // against REAL sockets rather than stubs: an inbound connection is accepted
  // under a grant, refused without one, and revoking the grant tears down
  // both the listening server and every socket it had already accepted.

  const APP = 'https://app.example'

  function realBroker (): ReturnType<typeof createBroker> {
    return createBroker({
      dial: async () => { throw new Error('not used by this test') },
      dialSecure: async () => { throw new Error('not used by this test') },
      bind: async () => { throw new Error('not used by this test') },
      listen: listenTcp,
      resolve: async () => [],
      now: () => Date.now(),
      fs: nodeFs('/tmp/orivon-listen-e2e-unused'),
      keychain: { getSeed: async () => { throw new Error('not used by this test') } }
    })
  }

  it('denies net.listen outright when tcp.listen was never granted', async () => {
    const broker = realBroker()
    broker.registerApp(APP, {
      orivonApiVersion: 0, id: 'org.orivon.test', name: 'Test', version: '1.0.0', entry: '/index.html',
      capabilities: { net: { tcp: { listen: ['30030-30040'] } } }
    })

    await expect(broker.net.listen(APP, { port: 30030 })).rejects.toMatchObject({ code: 'denied' })
  })

  it('accepts a real inbound connection under a grant, and revocation tears down the server and the accepted socket', async () => {
    const broker = realBroker()
    broker.registerApp(APP, {
      orivonApiVersion: 0, id: 'org.orivon.test', name: 'Test', version: '1.0.0', entry: '/index.html',
      capabilities: { net: { tcp: { listen: ['30030-30040'] } } }
    })
    const grant = await broker.grant(APP, 'tcp.listen', ['30030-30040'])

    const server = await broker.net.listen(APP, { port: 0 })
    expect(server.localPort).toBeGreaterThanOrEqual(30030)
    expect(server.localPort).toBeLessThanOrEqual(30040)

    const reader = server.connections.getReader()
    const readPromise = reader.read()
    const client = await connectClient(server.localPort)
    const { value: socket, done } = await readPromise

    expect(done).toBe(false)
    expect(socket).toBeDefined()
    expect(socket?.remoteAddress).toBe('127.0.0.1')

    const clientErrored = new Promise<NodeJS.ErrnoException>((resolve) => client.once('error', resolve))
    const socketClosedRejection = socket?.closed.catch((error: unknown) => error)

    await broker.revoke(APP, grant.id)

    // The accepted socket's own handle rejects 'revoked' -- the derived-
    // handle half of the cascade (handle-contracts.md's "Revocation"
    // section: "closing the server closes every socket it produced").
    await expect(socketClosedRejection).resolves.toMatchObject({ code: 'revoked' })
    // And the real wire effect: an RST reaches the client, not a clean FIN.
    const clientError = await clientErrored
    expect(clientError.code).toBe('ECONNRESET')
    // The server's own handle is gone too, not just the socket it produced.
    await expect(server.closed).rejects.toMatchObject({ code: 'revoked' })
  })
})
