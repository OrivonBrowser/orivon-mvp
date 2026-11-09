import { afterEach, describe, expect, it } from 'vitest'
import { createServer, request } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OWN_READ_HEADER } from '../../../loader/fetch/content-root.js'
import { RELAY_CHUNK_BYTES, RELAY_WINDOW_BYTES } from '../../../protocols/verifier-host/protocol.js'
import type { FromHost, RelayToHost } from '../../../protocols/verifier-host/protocol.js'
import { ShellRelay } from '../../../protocols/verifier-host/serve/shell-relay.js'
import type { AppRequestHandler } from '../../../loader/serve/serve.js'
import { ShellResponder } from '../shell-responder.js'

// The host's relay and the shell's responder joined by a port that delivers asynchronously, in order, as the parent port
// does: what a client of the host's server sees, and what the host is made to hold along the way.

const TOKEN = 'a-secret-chosen-at-random'
const PUBLIC = 'treat-as-public-address'

let server: Server | undefined
afterEach(async () => {
  const closing = server
  server = undefined
  if (closing === undefined) return
  closing.closeAllConnections()
  await new Promise<void>((resolve) => { closing.close(() => { resolve() }) })
})

interface Wire { readonly port: number, readonly relay: ShellRelay, readonly toShell: FromHost[], readonly toHost: RelayToHost[], mostHeld: () => number, aborted: () => number[] }

/** A server that answers `kept.example` through `handler` by way of the relay and the responder, and any other host with the text `network`. */
async function wire (handler: AppRequestHandler): Promise<Wire> {
  const toShell: FromHost[] = []
  const toHost: RelayToHost[] = []
  let relay: ShellRelay
  let sentBytes = 0
  let wroteBytes = 0
  let most = 0
  const aborted: number[] = []
  const responder = new ShellResponder({
    send: (message) => {
      toHost.push(message)
      if (message.type === 'relay-body') {
        sentBytes += message.chunk.byteLength
        most = Math.max(most, sentBytes - wroteBytes)
      }
      setImmediate(() => { relay.receive(message) })
      return true
    },
    handlerFor: (origin) => origin === 'https://kept.example' ? handler : undefined
  })
  relay = new ShellRelay({
    post: (message) => {
      toShell.push(message)
      if (message.type === 'relay-wrote') wroteBytes += message.bytes
      if (message.type === 'relay-abort') aborted.push(message.id)
      setImmediate(() => { if (message.type === 'relay-request' || message.type === 'relay-abort' || message.type === 'relay-wrote') responder.receive(message) })
    },
    ownReadToken: TOKEN
  })
  relay.setServed(['https://kept.example'])
  server = createServer((req, res) => {
    const host = (req.headers.host ?? '').toLowerCase()
    if (relay.wants(host, req.headers)) relay.relay(req, res, new URL(req.url ?? '/', `https://${host}`), PUBLIC)
    else res.writeHead(200).end('network')
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, relay, toShell, toHost, mostHeld: () => most, aborted: () => aborted }
}

async function until (check: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 2000; tries += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`never: ${what}`)
}

describe('a request for a host the shell serves, through the host\'s server', () => {
  it('is answered by the handler with its status, headers and body, and the answer is complete', async () => {
    const { port } = await wire(async (given) => new Response(`${given.method} ${new URL(given.url).pathname}`, { status: 203, headers: { 'x-from': 'the handler' } }))
    const reply = await new Promise<{ status: number, from: string | string[] | undefined, body: string }>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/dir/app.js', headers: { host: 'kept.example' } }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => { resolve({ status: res.statusCode ?? 0, from: res.headers['x-from'], body: Buffer.concat(chunks).toString() }) })
      })
      req.end()
    })
    expect(reply).toEqual({ status: 203, from: 'the handler', body: 'GET /dir/app.js' })
  })

  it('is not sent back to itself when the handler reads the host\'s server with the shell\'s mark', async () => {
    const holder: { port: number } = { port: 0 }
    const ownRead = async (): Promise<string> => await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: holder.port, path: '/app.js', headers: { host: 'kept.example', [OWN_READ_HEADER]: TOKEN } }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => { resolve(Buffer.concat(chunks).toString()) })
      })
      req.on('error', reject)
      req.end()
    })
    const live = await wire(async () => new Response(`the handler read: ${await ownRead()}`))
    holder.port = live.port
    const reply = await new Promise<string>((resolve) => {
      const req = request({ host: '127.0.0.1', port: live.port, path: '/app.js', headers: { host: 'kept.example' } }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => { resolve(Buffer.concat(chunks).toString()) })
      })
      req.end()
    })
    expect(reply).toBe('the handler read: network')
    expect(live.toShell.filter((message) => message.type === 'relay-request')).toHaveLength(1)
  })

  it('never has more than a window of a large file sent and not yet written, when the client reads slowly', async () => {
    const pieces = 64
    const size = 64 * 1024
    const total = pieces * size
    let pulled = 0
    const { port, mostHeld } = await wire(async () => new Response(new ReadableStream<Uint8Array>({
      pull (controller) {
        if (pulled >= pieces) { controller.close(); return }
        controller.enqueue(new Uint8Array(size).fill(pulled % 251))
        pulled += 1
      }
    }, { highWaterMark: 0 }), { headers: { 'content-length': String(total) } }))
    const received = await new Promise<number>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/big.bin', headers: { host: 'kept.example' } }, (res) => {
        let count = 0
        let order = true
        res.pause()
        const drip = (): void => {
          const chunk = res.read() as Buffer | null
          if (chunk !== null) {
            if (chunk[0] !== Math.floor(count / size) % 251) order = false
            count += chunk.length
          }
          if (count >= total) { resolve(order ? count : -1); return }
          setTimeout(drip, 2)
        }
        drip()
      })
      req.end()
    })
    expect(received).toBe(total)
    expect(mostHeld()).toBeGreaterThan(0)
    expect(mostHeld()).toBeLessThanOrEqual(RELAY_WINDOW_BYTES)
    // The handler's body was read as the window allowed, not all at once ahead of the socket.
    expect(pulled).toBe(pieces)
  })

  it('stops reading the handler\'s body when the client leaves', async () => {
    let cancelled = false
    let pulled = 0
    const { port, aborted } = await wire(async () => new Response(new ReadableStream<Uint8Array>({
      pull (controller) { controller.enqueue(new Uint8Array(RELAY_CHUNK_BYTES)); pulled += 1 },
      cancel () { cancelled = true }
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/octet-stream' } }))
    const req = request({ host: '127.0.0.1', port, path: '/endless.bin', headers: { host: 'kept.example' } }, (res) => {
      res.pause()
      setTimeout(() => { req.destroy() }, 50)
    })
    req.on('error', () => {})
    req.end()
    await until(() => cancelled, 'the handler\'s body was cancelled')
    expect(aborted()).toHaveLength(1)
    const stopped = pulled
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(pulled).toBe(stopped)
  })
})
