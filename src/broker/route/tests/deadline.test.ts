// The dial deadline over a routed connection: a route or a far end that never
// answers ends in `timeout`, and a caller's own abort stays an abort.

import { createServer } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { dialSecureThroughRoute } from '../routed-secure.js'
import { dialThroughRoute } from '../routed-socket.js'
import type { Route } from '../provider.js'
import { connectLocal } from '../../tests/net-route.test-helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()?.() })

const silentRoute = (): Route => ({ provider: { connect: async (_host, _port, signal) => await new Promise<Socket>((_resolve, reject) => { signal.addEventListener('abort', () => { reject(new Error('aborted')) }) }) } })

describe('the dial deadline over a route', () => {
  it('times out a route that never connects', async () => {
    await expect(dialThroughRoute(silentRoute(), 'a.example', 443, new AbortController().signal, 30)).rejects.toMatchObject({ code: 'timeout' })
  })

  it('keeps the caller\'s own abort an abort', async () => {
    const abort = new AbortController()
    const pending = dialThroughRoute(silentRoute(), 'a.example', 443, abort.signal, 5000)
    setTimeout(() => { abort.abort() }, 20)

    await expect(pending).rejects.toMatchObject({ code: 'revoked' })
  })

  it('times out a handshake the far end never answers, and closes the carrier', async () => {
    let accepted: Socket | undefined
    const server = createServer((socket) => { accepted = socket; socket.on('error', () => {}); socket.resume() })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    cleanups.push(async () => { accepted?.destroy(); await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) })
    const route: Route = { provider: { connect: async () => await connectLocal((server.address() as AddressInfo).port) } }

    await expect(dialSecureThroughRoute(route, { host: 'a.example', port: 443 }, {}, new AbortController().signal, 100)).rejects.toMatchObject({ code: 'timeout' })
    await new Promise<void>((resolve) => { if (accepted?.destroyed === true) resolve(); else accepted?.once('close', () => { resolve() }) })
    expect(accepted?.destroyed).toBe(true)
  })
})
