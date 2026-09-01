import { mkdtemp, readFile as fsReadFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dialTcp, nodeFs, resolveHost } from './node-adapters.js'

/** A once-only AbortController's signal -- dialTcp/dialOne need one, and none of these tests abort mid-dial. */
function neverAborts (): AbortSignal {
  return new AbortController().signal
}

describe('nodeFs (the real filesystem adapter)', () => {
  it('rootFor is sha256(origin), never the origin string (T13b)', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)

    const root = fs.rootFor('https://app.example')

    expect(root).not.toContain('app.example')
    expect(root).toMatch(/[0-9a-f]{64}[/\\]files$/)
  })

  it('writeFile then readFile round-trips, creating parent directories', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)
    const path = join(fs.rootFor('https://app.example'), 'a', 'b.txt')
    const data = new Uint8Array([1, 2, 3])

    await fs.writeFile(path, data)
    const back = await fs.readFile(path)

    expect(back).toEqual(data)
    expect(await fsReadFile(path)).toEqual(Buffer.from(data))
  })

  it('readFile of a missing file rejects with notFound, not a raw ENOENT', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)

    await expect(fs.readFile(join(userData, 'missing.txt'))).rejects.toMatchObject({ code: 'notFound' })
  })
})

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
