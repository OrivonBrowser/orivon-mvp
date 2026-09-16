// Exercises node-net.ts itself -- the module-map target a real `import 'net'`
// resolves to -- rather than node-net-socket.ts's Socket class
// (node-net-socket.test.ts's job) or node-net-server.ts's Server class
// (node-net-server.test.ts's job). Same stubbed-globalThis.orivon pattern as
// node-http-https-modules.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeTcpSocket } from './support/fake-tcp-socket.js'
import { createFakeTcpServer } from './support/fake-tcp-server.js'
import type { Orivon } from '../../contracts/capability-api.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }

function installFakeOrivon (): {
  connectCalls: Array<{ host: string, port: number }>
  listenCalls: Array<{ port: number }>
  fakeServer: ReturnType<typeof createFakeTcpServer>
} {
  const connectCalls: Array<{ host: string, port: number }> = []
  const listenCalls: Array<{ port: number }> = []
  const fakeSocket = createFakeTcpSocket()
  const fakeServer = createFakeTcpServer()
  ;(globalThis as GlobalWithOrivon).orivon = {
    net: {
      connect: async (opts: { host: string, port: number }) => { connectCalls.push(opts); return fakeSocket.socket },
      connectSecure: async () => { throw new Error('not used in this test') },
      listen: async (opts: { port: number }) => { listenCalls.push(opts); return fakeServer.server },
      udpBind: async () => { throw new Error('not used in this test') }
    }
  } as unknown as Orivon
  return { connectCalls, listenCalls, fakeServer }
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

  it('createServer() routes through orivon.net.listen -- Server\'s own behaviour is node-net-server.test.ts\'s job', async () => {
    const { listenCalls } = installFakeOrivon()
    const net = await import('../node-net.js')
    net.createServer().listen(6881)
    await vi.waitFor(() => expect(listenCalls).toHaveLength(1))
    expect(listenCalls[0]).toEqual({ port: 6881 })
  })

  it('createServer(connectionListener) attaches it as a real \'connection\' listener', async () => {
    const { fakeServer } = installFakeOrivon()
    const net = await import('../node-net.js')
    const onConnection = vi.fn()
    net.createServer(onConnection).listen(6881)
    fakeServer.deliver(createFakeTcpSocket().socket)
    await vi.waitFor(() => expect(onConnection).toHaveBeenCalledOnce())
  })

  it('surfaces a clear, named "error" event if window.orivon is absent when connect is attempted', async () => {
    const net = await import('../node-net.js')
    const socket = net.connect({ host: 'example.com', port: 80 })
    const error = await new Promise<Error>((resolve) => socket.once('error', resolve))
    expect(error.message).toMatch(/window\.orivon/)
  })

  it('surfaces a clear, named "error" event if window.orivon is absent when listen is attempted', async () => {
    const net = await import('../node-net.js')
    const server = net.createServer().listen(6881)
    const error = await new Promise<Error>((resolve) => server.once('error', resolve))
    expect(error.message).toMatch(/window\.orivon/)
  })

  // A135: members read off the default export (a bundled CJS `require('net')`'s
  // own shape) used to be silently absent rather than named. connect/
  // createServer/Socket/Server are now real, decided, built surface --
  // everything else is still unimplemented.
  it('names any other unbuilt member, reason unimplemented', async () => {
    installFakeOrivon()
    const net = (await import('../node-net.js')).default as unknown as Record<string, unknown>
    const { OrivonShimError } = await import('../errors.js')
    expect(() => net.getDefaultAutoSelectFamily).toThrow(OrivonShimError)
    try {
      void net.getDefaultAutoSelectFamily
    } catch (error) {
      expect((error as InstanceType<typeof OrivonShimError>).reason).toBe('unimplemented')
    }
  })
})
