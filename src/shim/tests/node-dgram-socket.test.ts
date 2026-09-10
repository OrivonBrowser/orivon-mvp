import { describe, expect, it, vi } from 'vitest'
import { Socket } from '../node-dgram-socket.js'
import { createFakeUdpSocket } from './support/fake-udp-socket.js'
import type { Datagram, UdpSocket } from '../../contracts/handles.js'

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

    expect(Buffer.isBuffer(buf)).toBe(true)
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
})
