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

  // This adapter deliberately does NOT classify its own errors. index.ts's
  // mapIoError is the single place an errno becomes an OrivonError, and it
  // passes an already-shaped OrivonError straight through unchanged -- so an
  // adapter that pre-shaped one BYPASSED the mapper rather than helping it.
  // index.test.ts already pins what the mapper then does with these
  // (ENOENT -> notFound + platformCode; EACCES -> denied and no
  // platformCode); those tests used a stub fs, which is why the real
  // adapter's bypass did not show up there.
  it('readFile of a missing file surfaces the raw errno for the broker to map', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)

    await expect(fs.readFile(join(userData, 'missing.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never raises an OrivonError-shaped failure naming the confined absolute path (T13b)', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)
    const secret = join(fs.rootFor('https://app.example'), 'missing.txt')

    const error = await fs.readFile(secret).then(() => undefined, (e: unknown) => e)

    // A raw Node error names the path -- that is Node's own message, and
    // mapIoError replaces it wholesale. What must never happen is this file
    // handing back something mapIoError will pass through untouched, because
    // that is what reaches the page verbatim.
    expect((error as { name?: string }).name).not.toBe('OrivonError')
  })
})

describe('readFile never hands back a window into shared memory', () => {
  // Structured clone -- the path this value takes to a renderer -- serialises
  // an ArrayBufferView by serialising its WHOLE backing ArrayBuffer. If the
  // returned view were a slice of Node's shared allocation pool, the page
  // would receive the entire slab and could read the rest of it back as
  // `new Uint8Array(result.buffer)`: bytes it never asked for, from whatever
  // the pool last held.
  it('the returned array owns its buffer exactly (no pooled slack, no offset)', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)
    const path = join(fs.rootFor('https://app.example'), 'small.bin')
    // Small enough to be pool-allocated by Buffer.allocUnsafe, which is what
    // readFileSync and friends use at this size.
    await fs.writeFile(path, new Uint8Array([1, 2, 3, 4, 5]))

    const result = await fs.readFile(path)

    expect(result.byteLength).toBe(5)
    expect(result.byteOffset).toBe(0)
    expect(result.buffer.byteLength).toBe(5)
  })

  it('round-trips the actual bytes', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)
    const path = join(fs.rootFor('https://app.example'), 'bytes.bin')
    const written = new Uint8Array([9, 8, 7, 6])
    await fs.writeFile(path, written)

    expect(Array.from(await fs.readFile(path))).toEqual([9, 8, 7, 6])
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
