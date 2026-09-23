import { describe, expect, it, vi } from 'vitest'
import { Socket } from '../node-dgram-socket.js'
import { createFakeUdpSocket } from './support/fake-udp-socket.js'
import { PageBuffer } from './support/page-buffer.js'
import type { Datagram, UdpSocket } from '../../contracts/handles.js'
import { OrivonShimError } from '../errors.js'

describe('dgram.Socket over a fake UdpSocket', () => {
  it('fires "listening" and reports a synchronous, real address() -- Handle rule 3', async () => {
    const fake = createFakeUdpSocket({ localAddress: '0.0.0.0', localPort: 6881 })
    const socket = new Socket(async () => fake.socket)
    const listening = new Promise<void>((resolve) => socket.once('listening', resolve))
    socket.bind(6881)
    await listening
    expect(socket.address()).toEqual({ address: '0.0.0.0', port: 6881, family: 'IPv4' })
  })

  it('throws calling address() before bind resolves -- no cache filled in later (Handle rule 3)', () => {
    const socket = new Socket(async () => createFakeUdpSocket().socket)
    expect(() => socket.address()).toThrow(/not bound/)
  })

  it('emits "message" with a real Buffer and the rinfo shape k-rpc-socket reads', async () => {
    const fake = createFakeUdpSocket()
    const socket = new Socket(async () => fake.socket)
    socket.bind(0)
    await new Promise<void>((resolve) => socket.once('listening', resolve))

    const received = new Promise<[Buffer, unknown]>((resolve) => {
      socket.once('message', (buf: Buffer, rinfo: unknown) => resolve([buf, rinfo]))
    })
    fake.deliver({ data: new Uint8Array([1, 2, 3]), address: '1.2.3.4', port: 6881, family: 'IPv4' })
    const [buf, rinfo] = await received

    expect(PageBuffer.isBuffer(buf)).toBe(true)
    expect([...buf]).toEqual([1, 2, 3])
    expect(rinfo).toEqual({ address: '1.2.3.4', port: 6881, family: 'IPv4', size: 3 })
  })

  it('send() writes a Datagram with the 6-argument (buf, offset, length, port, address, cb) form k-rpc-socket uses', async () => {
    const fake = createFakeUdpSocket()
    const socket = new Socket(async () => fake.socket)
    socket.bind(0)
    await new Promise<void>((resolve) => socket.once('listening', resolve))

    const buf = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd])
    const cb = vi.fn()
    socket.send(buf, 1, 2, 6881, '5.6.7.8', cb)
    await vi.waitFor(() => expect(cb).toHaveBeenCalledWith(null))

    const [datagram] = fake.sent
    expect(datagram).toBeDefined()
    expect([...(datagram as Datagram).data]).toEqual([0xbb, 0xcc])
    expect(datagram).toMatchObject({ address: '5.6.7.8', port: 6881, family: 'IPv4' })
  })

  it('send() before bind() implicitly binds first, matching real dgram', async () => {
    const fake = createFakeUdpSocket()
    const socket = new Socket(async () => fake.socket)
    const cb = vi.fn()
    socket.send(new Uint8Array([1]), 6881, '9.9.9.9', cb)
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1))
    expect(cb).toHaveBeenCalledWith(null)
  })

  it('bind() forwards every argument shape k-rpc-socket\'s bind.apply can produce', async () => {
    let seenPort: number | undefined
    const bindFn = async (opts: { port: number }): Promise<UdpSocket> => {
      seenPort = opts.port
      return createFakeUdpSocket({ localPort: opts.port }).socket
    }

    const onListening = vi.fn()
    const s1 = new Socket(bindFn)
    s1.bind(6881, '0.0.0.0', onListening)
    await new Promise<void>((resolve) => s1.once('listening', resolve))
    expect(seenPort).toBe(6881)
    expect(onListening).toHaveBeenCalled()

    const s2 = new Socket(bindFn)
    s2.bind(6882)
    await new Promise<void>((resolve) => s2.once('listening', resolve))
    expect(seenPort).toBe(6882)
  })

  it('close() emits "close" once the underlying handle is released', async () => {
    const fake = createFakeUdpSocket()
    const socket = new Socket(async () => fake.socket)
    socket.bind(0)
    await new Promise<void>((resolve) => socket.once('listening', resolve))

    const closed = new Promise<void>((resolve) => socket.once('close', resolve))
    socket.close()
    await closed
    expect(fake.closed()).toBe(true)
  })

  it('a rejected bind surfaces as a named "error" event, never a thrown exception', async () => {
    const denied = Object.assign(new Error('no udp.bind grant'), { code: 'denied' })
    const socket = new Socket(async () => { throw denied })
    const error = new Promise<Error & { code?: string }>((resolve) => socket.once('error', resolve))
    socket.bind(6881)
    expect((await error).code).toBe('denied')
  })

  // The three below came out of the 2026-09-11 post-merge audit of this file
  // (R8). It had never been assigned to a review lane, and the one test that
  // exercises it against a real caller -- real-bittorrent-dht.test.ts -- is
  // skipped in every checkout, so nothing executing would have caught these.

  it('a second bind() is refused, rather than orphaning the first handle -- ERR_SOCKET_ALREADY_BOUND', async () => {
    const first = createFakeUdpSocket({ localPort: 6881 })
    const second = createFakeUdpSocket({ localPort: 6882 })
    const handles = [first.socket, second.socket]
    const socket = new Socket(async () => handles.shift() as UdpSocket)
    socket.bind(6881)
    await new Promise<void>((resolve) => socket.once('listening', resolve))

    expect(() => socket.bind(6882)).toThrow(/already bound/)
    // The point of the throw: without it the second bind replaced `handle`,
    // leaving `first` open and unreachable -- nothing could ever close it, and
    // it kept consuming one of the app's manifest-declared socket slots (A80).
    expect(first.closed()).toBe(false)
    expect(socket.address().port).toBe(6881)
    expect(handles).toHaveLength(1)
  })

  it('send() accepts Node\'s ARRAY message form, sending the concatenation rather than throwing', async () => {
    const fake = createFakeUdpSocket()
    const socket = new Socket(async () => fake.socket)
    socket.bind(0)
    await new Promise<void>((resolve) => socket.once('listening', resolve))

    const sent = new Promise<void>((resolve) => { socket.send([new Uint8Array([1, 2]), 'AB'], 9999, '203.0.113.9', () => { resolve() }) })
    await sent
    const datagram = fake.sent[0] as Datagram
    expect(Array.from(datagram.data)).toEqual([1, 2, 0x41, 0x42])
    expect(datagram.port).toBe(9999)
  })

  it('close() twice throws ERR_SOCKET_DGRAM_NOT_RUNNING instead of emitting "close" a second time', async () => {
    const fake = createFakeUdpSocket()
    const socket = new Socket(async () => fake.socket)
    socket.bind(0)
    await new Promise<void>((resolve) => socket.once('listening', resolve))

    const closes = vi.fn()
    socket.on('close', closes)
    socket.close()
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    expect(() => socket.close()).toThrow(/not running/i)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    expect(closes).toHaveBeenCalledTimes(1)
  })

  // Both below came out of the adversarial security-review pass over the PR
  // that added the bind guard directly above (#154). The guard was right about
  // a bind that SUCCEEDED and wrong about one that FAILED.

  it('a bind that FAILED leaves the socket re-bindable -- a denial must not brick it permanently', async () => {
    let attempt = 0
    const second = createFakeUdpSocket({ localPort: 6882 })
    const socket = new Socket(async () => {
      attempt++
      if (attempt === 1) throw Object.assign(new Error('no udp.bind grant'), { code: 'denied' })
      return second.socket
    })

    const denial = new Promise<Error & { code?: string }>((resolve) => socket.once('error', resolve))
    socket.bind(6881)
    expect((await denial).code).toBe('denied')

    // The path this protects is the ordinary one once the grant prompt exists:
    // udpBind is denied, the user approves, the app retries. Before this, the
    // retry threw ERR_SOCKET_ALREADY_BOUND forever with nothing bound at all.
    const listening = new Promise<void>((resolve) => socket.once('listening', resolve))
    expect(() => socket.bind(6882)).not.toThrow()
    await listening
    expect(socket.address().port).toBe(6882)
  })

  it('send() refuses offset/length paired with an array message, as Node does, instead of slicing the join', async () => {
    const fake = createFakeUdpSocket()
    const socket = new Socket(async () => fake.socket)
    socket.bind(0)
    await new Promise<void>((resolve) => socket.once('listening', resolve))

    expect(() => {
      socket.send([new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6])], 0, 2, 9999, '203.0.113.9', () => {})
    }).toThrow(/offset\/length with an array message/)
    expect(fake.sent).toHaveLength(0)
  })
})

// A135: named by presence, not by absence -- same reasoning as
// node-net-socket.ts's own ref/unref/setTimeout methods, and not the
// module-level refusingProxy wrap node-net.ts/node-dns.ts/node-fs.ts use,
// for the identical duck-typing reason (dgram.Socket is a stateful,
// feature-detected EventEmitter instance, not a plain module namespace).
describe('dgram.Socket -- named refusal without breaking duck-typing (A135)', () => {
  it('ref()/unref() are real, present, safe no-ops that return `this`', () => {
    const fake = createFakeUdpSocket()
    const socket = new Socket(async () => fake.socket)
    expect(typeof socket.unref).toBe('function')
    expect(socket.unref()).toBe(socket)
    expect(socket.ref()).toBe(socket)
  })

  it.each([
    ['setBroadcast', [true]],
    ['setMulticastTTL', [64]],
    ['setMulticastLoopback', [true]],
    ['addMembership', ['230.185.192.108']],
    ['dropMembership', ['230.185.192.108']]
  ] as const)('%s is present (typeof check passes) but throws a named error when actually called', (method, args) => {
    const fake = createFakeUdpSocket()
    const socket = new Socket(async () => fake.socket)
    expect(typeof socket[method]).toBe('function')
    expect(() => (socket[method] as (...a: unknown[]) => void)(...args)).toThrow(OrivonShimError)
    try {
      ;(socket[method] as (...a: unknown[]) => void)(...args)
    } catch (error) {
      expect((error as OrivonShimError).api).toBe(`dgram.Socket#${method}`)
      expect((error as OrivonShimError).reason).toBe('unimplemented')
    }
  })
})

describe('dgram.Socket#send -- validated in the shim, as Node validates it, before anything reaches the broker', () => {
  async function bound (lookup?: (host: string) => Promise<string>): Promise<{ socket: Socket, fake: ReturnType<typeof createFakeUdpSocket> }> {
    const fake = createFakeUdpSocket()
    const socket = lookup === undefined
      ? new Socket(async () => fake.socket)
      : new Socket(async () => fake.socket, async (host) => await lookup(host))
    socket.bind(0)
    await new Promise<void>((resolve) => socket.once('listening', resolve))
    return { socket, fake }
  }

  it.each([0, 70000, -1, '', 'abc'])('throws ERR_SOCKET_BAD_PORT for port %j and sends nothing', async (port) => {
    const { socket, fake } = await bound()
    expect(() => socket.send(new Uint8Array([1]), port, '1.2.3.4')).toThrow(expect.objectContaining({ code: 'ERR_SOCKET_BAD_PORT' }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(fake.sent).toHaveLength(0)
  })

  it('coerces a numeric string port', async () => {
    const { socket, fake } = await bound()
    socket.send(new Uint8Array([1]), '6881', '1.2.3.4')
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1))
    expect(fake.sent[0]).toMatchObject({ port: 6881, address: '1.2.3.4' })
  })

  it('throws ERR_INVALID_ARG_TYPE for a non-string address', async () => {
    const { socket } = await bound()
    expect(() => socket.send(new Uint8Array([1]), 6881, 1234 as unknown as string)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }))
  })

  it('calls back with EMSGSIZE for a payload over 65507 bytes, never sending it', async () => {
    const { socket, fake } = await bound()
    const error = await new Promise<Error | null>((resolve) => socket.send(new Uint8Array(65508), 6881, '1.2.3.4', resolve))
    expect(error).toMatchObject({ code: 'EMSGSIZE', syscall: 'send', address: '1.2.3.4', port: 6881 })
    expect(fake.sent).toHaveLength(0)
  })

  it('an oversized send with no callback surfaces as the socket\'s "error", as Node does', async () => {
    const { socket } = await bound()
    const error = new Promise<Error & { code?: string }>((resolve) => socket.once('error', resolve))
    socket.send(new Uint8Array(70000), 6881, '1.2.3.4')
    expect((await error).code).toBe('EMSGSIZE')
  })

  it('resolves a hostname before sending, and reports a failed lookup instead of sending', async () => {
    const { socket, fake } = await bound(async (host) => {
      if (host === 'router.example') return '67.215.246.10'
      throw Object.assign(new Error('no records'), { code: 'ENOTFOUND' })
    })
    socket.send(new Uint8Array([1]), 6881, 'router.example')
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1))
    expect(fake.sent[0]).toMatchObject({ address: '67.215.246.10', family: 'IPv4' })
    const error = await new Promise<Error | null>((resolve) => socket.send(new Uint8Array([1]), 6881, 'nowhere.example', resolve))
    expect(error).toMatchObject({ code: 'ENOTFOUND' })
    expect(fake.sent).toHaveLength(1)
  })

  it('accepts any ArrayBufferView, as Node does', async () => {
    const { socket, fake } = await bound()
    socket.send(new DataView(new Uint8Array([7, 8]).buffer), 6881, '1.2.3.4')
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1))
    expect([...(fake.sent[0] as Datagram).data]).toEqual([7, 8])
  })

  it('throws ERR_SOCKET_DGRAM_NOT_RUNNING for a send after close()', async () => {
    const { socket } = await bound()
    socket.close()
    expect(() => socket.send(new Uint8Array([1]), 6881, '1.2.3.4')).toThrow(expect.objectContaining({ code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' }))
  })
})
