// Exercises node-net.ts itself -- the module-map target a real `import 'net'`
// resolves to -- rather than node-net-socket.ts's Socket class
// (node-net-socket.test.ts's job). Same stubbed-globalThis.orivon pattern as
// node-http-https-modules.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeTcpSocket } from './support/fake-tcp-socket.js'
import type { Orivon } from '../../contracts/capability-api.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }

function installFakeOrivon (): { connectCalls: Array<{ host: string, port: number }> } {
  const connectCalls: Array<{ host: string, port: number }> = []
  const fake = createFakeTcpSocket()
  ;(globalThis as GlobalWithOrivon).orivon = {
    net: {
      connect: async (opts: { host: string, port: number }) => { connectCalls.push(opts); return fake.socket },
      connectSecure: async () => { throw new Error('not used in this test') },
      listen: async () => { throw new Error('not used in this test') },
      udpBind: async () => { throw new Error('not used in this test') }
    }
  } as unknown as Orivon
  return { connectCalls }
}

afterEach(() => {
  delete (globalThis as GlobalWithOrivon).orivon
  vi.resetModules()
})

describe('node-net.ts', () => {
  it('connect() routes through orivon.net.connect', async () => {
    const { connectCalls } = installFakeOrivon()
    const net = await import('../node-net.js')
    net.connect({ host: 'router.bittorrent.com', port: 6881 })
    await vi.waitFor(() => expect(connectCalls).toHaveLength(1))
    expect(connectCalls[0]).toEqual({ host: 'router.bittorrent.com', port: 6881 })
  })

  it('createConnection is the same factory as connect', async () => {
    installFakeOrivon()
    const net = await import('../node-net.js')
    expect(net.createConnection).toBe(net.connect)
  })

  it('exports isIP/isIPv4/isIPv6, both named and on the default export', async () => {
    installFakeOrivon()
    const net = await import('../node-net.js')
    expect(net.isIP('67.215.246.10')).toBe(4)
    expect(net.default.isIP('67.215.246.10')).toBe(4)
  })

  it('createServer throws a named, explanatory error citing A114 rather than pretending to listen', async () => {
    installFakeOrivon()
    const net = await import('../node-net.js')
    expect(() => net.createServer()).toThrow(/A114/)
  })

  it('surfaces a clear, named "error" event if window.orivon is absent when connect is attempted', async () => {
    const net = await import('../node-net.js')
    const socket = net.connect({ host: 'example.com', port: 80 })
    const error = await new Promise<Error>((resolve) => socket.once('error', resolve))
    expect(error.message).toMatch(/window\.orivon/)
  })
})
