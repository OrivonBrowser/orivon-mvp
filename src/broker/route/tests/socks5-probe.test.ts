// The Test action's handshake: a SOCKS5 greeting that offers "no authentication" and username/password, and what the
// proxy's answer (or lack of one) means. It opens no stream to anywhere.

import { createServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { probeSocks5 } from '../socks5-probe.js'
import { startSocks5Fixture } from './socks5-fixture.test-helpers.js'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function serverThat (onConnection: (socket: Socket) => void): Promise<number> {
  const open = new Set<Socket>()
  const server: Server = createServer((socket) => { open.add(socket); socket.on('close', () => open.delete(socket)); socket.on('error', () => {}); onConnection(socket) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  cleanups.push(async () => {
    for (const socket of open) socket.destroy()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  return (server.address() as AddressInfo).port
}

describe('probeSocks5', () => {
  it('finds a SOCKS5 proxy that takes no authentication', async () => {
    const proxy = await startSocks5Fixture()
    cleanups.push(proxy.close)

    expect(await probeSocks5({ host: proxy.host, port: proxy.port })).toEqual({ ok: true, authentication: 'none' })
    expect(proxy.requests).toEqual([])
  })

  it('finds one that prefers a user name and password, as Tor does when it isolates by them', async () => {
    const proxy = await startSocks5Fixture({ preferAuth: true })
    cleanups.push(proxy.close)

    expect(await probeSocks5({ host: proxy.host, port: proxy.port })).toEqual({ ok: true, authentication: 'password' })
  })

  it('says the proxy accepts neither method when it answers "no acceptable method"', async () => {
    const port = await serverThat((socket) => { socket.once('data', () => { socket.end(Buffer.from([0x05, 0xff])) }) })
    expect(await probeSocks5({ host: '127.0.0.1', port })).toEqual({ ok: false, reason: 'refused' })
  })

  it('says it is not SOCKS5 when something else answers', async () => {
    const http = await serverThat((socket) => { socket.once('data', () => { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') }) })
    expect(await probeSocks5({ host: '127.0.0.1', port: http })).toEqual({ ok: false, reason: 'not-socks5' })
    const socks4 = await serverThat((socket) => { socket.once('data', () => { socket.end(Buffer.from([0x00, 0x5b, 0, 0, 0, 0, 0, 0])) }) })
    expect(await probeSocks5({ host: '127.0.0.1', port: socks4 })).toEqual({ ok: false, reason: 'not-socks5' })
  })

  it('says nothing is listening when the connection is refused', async () => {
    const port = await serverThat(() => {})
    await Promise.all(cleanups.splice(0).map(async (cleanup) => { await cleanup() }))
    expect(await probeSocks5({ host: '127.0.0.1', port })).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('gives up on a proxy that accepts the connection and never answers', async () => {
    const port = await serverThat(() => {})
    expect(await probeSocks5({ host: '127.0.0.1', port, timeoutMs: 50 })).toEqual({ ok: false, reason: 'silent' })
  })
})
