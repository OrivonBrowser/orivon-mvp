// ClientRequest/IncomingMessage lifecycle checks, defined once and run
// under node:stream (node-http-client-features.test.ts) and readable-stream
// 3 (node-http-client-rs3.test.ts), for the same reason as
// socket-lifecycle-suite.ts: the renderer's stream defaults differ.

import { describe, expect, it, vi } from 'vitest'
import { createHttpModule, type ClientRequest } from '../../node-http-client.js'
import type { IncomingMessage } from '../../node-http-message.js'
import { createFakeTcpSocket, type FakeTcpSocket } from './fake-tcp-socket.js'

const enc = new TextEncoder()

async function requestOver (fake: FakeTcpSocket): Promise<ClientRequest> {
  const http = createHttpModule({ connect: async () => fake.socket, defaultPort: 80 })
  const req = http.get({ host: 'example.com', path: '/' })
  await vi.waitFor(() => expect(fake.written.length).toBeGreaterThan(0))
  return req
}

function nextResponse (req: ClientRequest): Promise<IncomingMessage> {
  return new Promise((resolve) => req.once('response', resolve))
}

export function httpLifecycleSuite (streamLabel: string): void {
  describe(`http client lifecycle under ${streamLabel}`, () => {
    it('never half-closes after the request, then closes response, request and socket once the response ends', async () => {
      const fake = createFakeTcpSocket()
      const req = await requestOver(fake)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(fake.finSent()).toBe(false)

      const order: string[] = []
      req.on('close', () => order.push('req close'))
      fake.push(enc.encode('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi'))
      const res = await nextResponse(req)
      res.on('end', () => order.push('res end'))
      const resClosed = new Promise<void>((resolve) => res.on('close', () => { order.push('res close'); resolve() }))
      res.resume()
      await resClosed
      await vi.waitFor(() => expect(order).toContain('req close'))
      expect(order.indexOf('res end')).toBeLessThan(order.indexOf('res close'))
      expect(fake.closed()).toBe(true)
    })

    it('stops pulling from the socket while the response consumer is behind, and resumes when it reads', async () => {
      const fake = createFakeTcpSocket()
      const req = await requestOver(fake)
      const chunk = new Uint8Array(16 * 1024).fill(97)
      const total = chunk.length * 16
      fake.push(enc.encode(`HTTP/1.1 200 OK\r\nContent-Length: ${total}\r\n\r\n`))
      for (let i = 0; i < 16; i++) fake.push(chunk)
      const res = await nextResponse(req)
      await new Promise((resolve) => setTimeout(resolve, 30))
      const socket = req.socket as unknown as { bytesRead: number }
      expect(socket.bytesRead).toBeLessThan(total)

      let received = 0
      res.on('data', (data: Uint8Array) => { received += data.length })
      await new Promise<void>((resolve) => res.once('end', resolve))
      expect(received).toBe(total)
    })

    it('destroy() before any response reports "socket hang up" once, closes the socket, and ignores what the socket does after', async () => {
      const fake = createFakeTcpSocket()
      const req = await requestOver(fake)
      const onError = vi.fn()
      req.on('error', onError)
      const closed = new Promise<void>((resolve) => req.once('close', () => resolve()))
      req.destroy()
      await closed
      expect(onError).toHaveBeenCalledOnce()
      expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'ECONNRESET', message: 'socket hang up' })
      await vi.waitFor(() => expect(fake.closed()).toBe(true))
      fake.fail('reset', 'late reset')
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(onError).toHaveBeenCalledOnce()
    })

    it('abort() closes without an error and emits "abort"', async () => {
      const fake = createFakeTcpSocket()
      const req = await requestOver(fake)
      const onError = vi.fn()
      req.on('error', onError)
      const aborted = new Promise<void>((resolve) => req.once('abort', resolve))
      req.abort()
      await aborted
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(req.aborted).toBe(true)
      expect(req.destroyed).toBe(true)
      expect(onError).not.toHaveBeenCalled()
    })

    it('res.destroy() mid-body with no error listener throws nothing and closes the socket', async () => {
      const fake = createFakeTcpSocket()
      const req = await requestOver(fake)
      req.on('error', () => {})
      fake.push(enc.encode('HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\npart'))
      const res = await nextResponse(req)
      const closed = new Promise<void>((resolve) => res.once('close', () => resolve()))
      res.destroy(new Error('consumer gave up'))
      await closed
      expect(res.aborted).toBe(true)
      await vi.waitFor(() => expect(fake.closed()).toBe(true))
    })
  })
}
