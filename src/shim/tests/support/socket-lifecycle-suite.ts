// The net.Socket lifecycle checks, defined once and run twice: under
// vitest's own `node:stream` (node-net-socket.test.ts) and under
// readable-stream 3, the `stream` the renderer actually gets
// (node-net-socket-rs3.test.ts, which mocks 'stream' to stream-browserify).
// readable-stream 3 defaults autoDestroy to false, so a lifecycle that only
// holds under node:stream is the bug these exist to catch.

import { describe, expect, it, vi } from 'vitest'
import { Socket, kDial } from '../../node-net-socket.js'
import { createFakeTcpSocket, type FakeTcpSocket } from './fake-tcp-socket.js'

async function connected (fake: FakeTcpSocket, opts: { allowHalfOpen?: boolean } = {}): Promise<Socket> {
  const socket = new Socket({ ...opts, [kDial]: async () => fake.socket })
  const ready = new Promise<void>((resolve) => socket.once('connect', resolve))
  socket.connect(1, 'x')
  await ready
  return socket
}

export function socketLifecycleSuite (streamLabel: string): void {
  describe(`net.Socket lifecycle under ${streamLabel}`, () => {
    it('emits "close" once both sides ended, and closes the broker handle', async () => {
      const fake = createFakeTcpSocket()
      const socket = await connected(fake)
      socket.resume()
      const closed = new Promise<boolean>((resolve) => socket.once('close', resolve))
      socket.end('bye')
      fake.end()
      expect(await closed).toBe(false)
      expect(fake.closed()).toBe(true)
      expect(fake.rstSent()).toBe(false)
    })

    it('ends its own side when the peer sends FIN (allowHalfOpen defaults to false), then closes', async () => {
      const fake = createFakeTcpSocket()
      const socket = await connected(fake)
      socket.resume()
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
      fake.end()
      await closed
      expect(fake.finSent()).toBe(true)
      expect(fake.closed()).toBe(true)
    })

    it('with allowHalfOpen, stays writable after the peer FIN until it ends itself', async () => {
      const fake = createFakeTcpSocket()
      const socket = await connected(fake, { allowHalfOpen: true })
      socket.resume()
      await new Promise<void>((resolve) => { socket.once('end', resolve); fake.end() })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(fake.finSent()).toBe(false)
      expect(socket.destroyed).toBe(false)
      socket.end('late reply')
      await new Promise<void>((resolve) => socket.once('close', () => resolve()))
      expect(new TextDecoder().decode(fake.written.at(-1))).toBe('late reply')
    })

    it('a peer reset closes with hadError true after exactly one "error"', async () => {
      const fake = createFakeTcpSocket()
      const socket = await connected(fake)
      socket.resume()
      const onError = vi.fn()
      socket.on('error', onError)
      const closed = new Promise<boolean>((resolve) => socket.once('close', resolve))
      fake.fail('reset', 'peer reset')
      expect(await closed).toBe(true)
      expect(onError).toHaveBeenCalledOnce()
    })

    it('destroying twice with an error emits "error" once, never an unhandled second one', async () => {
      const fake = createFakeTcpSocket()
      const socket = await connected(fake)
      const onError = vi.fn()
      socket.on('error', onError)
      socket.destroy(new Error('first'))
      socket.destroy(new Error('second'))
      await new Promise<void>((resolve) => socket.once('close', () => resolve()))
      expect(onError).toHaveBeenCalledOnce()
      expect(fake.rstSent()).toBe(true)
    })

    it('a clean destroy() sends FIN, not RST, and releases the handle', async () => {
      const fake = createFakeTcpSocket()
      const socket = await connected(fake)
      socket.destroy()
      await new Promise<void>((resolve) => socket.once('close', () => resolve()))
      expect(fake.closed()).toBe(true)
      expect(fake.rstSent()).toBe(false)
    })
  })
}
