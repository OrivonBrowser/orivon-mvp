// Exercises node-http.ts and node-https.ts themselves -- the module-map
// targets a real `import 'http'`/`import 'https'` resolves to -- rather than
// the shared factory they both wrap (that is node-http-client.test.ts's
// job). Stubs `globalThis.orivon` the same way a real preload's
// contextBridge surface would install it, so this proves the wiring (which
// capability method each module calls, which port each defaults to) without
// needing a broker or an Electron launch.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeTcpSocket } from './support/fake-tcp-socket.js'
import type { Orivon } from '../../contracts/capability-api.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }

function installFakeOrivon (): { connectCalls: Array<{ host: string, port: number }>, connectSecureCalls: Array<{ host: string, port: number }> } {
  const connectCalls: Array<{ host: string, port: number }> = []
  const connectSecureCalls: Array<{ host: string, port: number }> = []
  const fake = createFakeTcpSocket()

  ;(globalThis as GlobalWithOrivon).orivon = {
    net: {
      connect: async (opts: { host: string, port: number }) => { connectCalls.push(opts); return fake.socket },
      connectSecure: async (opts: { host: string, port: number }) => { connectSecureCalls.push(opts); return fake.socket },
      listen: async () => { throw new Error('not used in this test') },
      udpBind: async () => { throw new Error('not used in this test') }
    }
  } as unknown as Orivon

  return { connectCalls, connectSecureCalls }
}

afterEach(() => {
  delete (globalThis as GlobalWithOrivon).orivon
  vi.resetModules()
})

describe('node-http.ts', () => {
  it('routes through orivon.net.connect and defaults to port 80', async () => {
    const { connectCalls } = installFakeOrivon()
    const http = await import('../node-http.js')
    http.get({ host: 'example.com', path: '/' })
    await vi.waitFor(() => expect(connectCalls).toHaveLength(1))
    expect(connectCalls[0]).toEqual({ host: 'example.com', port: 80 })
  })

  it('exports STATUS_CODES and METHODS as non-empty, both as named and default exports', async () => {
    installFakeOrivon()
    const http = await import('../node-http.js')
    expect(http.STATUS_CODES[404]).toBe('Not Found')
    expect(http.METHODS).toContain('GET')
    expect(http.default.STATUS_CODES[200]).toBe('OK')
  })

  it('createServer throws a named, explanatory error rather than pretending to listen', async () => {
    installFakeOrivon()
    const http = await import('../node-http.js')
    expect(() => http.createServer()).toThrow(/net\.listen/)
  })

  it('surfaces a clear, named "error" event if window.orivon is absent when a request is attempted', async () => {
    const http = await import('../node-http.js')
    const req = http.get({ host: 'example.com', path: '/' })
    const error = await new Promise<Error>((resolve) => req.once('error', resolve))
    expect(error.message).toMatch(/window\.orivon/)
  })
})

describe('node-https.ts', () => {
  it('routes through orivon.net.connectSecure and defaults to port 443', async () => {
    const { connectSecureCalls } = installFakeOrivon()
    const https = await import('../node-https.js')
    https.get({ host: 'example.com', path: '/' })
    await vi.waitFor(() => expect(connectSecureCalls).toHaveLength(1))
    expect(connectSecureCalls[0]).toEqual({ host: 'example.com', port: 443 })
  })

  it('never routes an https request through plain net.connect', async () => {
    const { connectCalls } = installFakeOrivon()
    const https = await import('../node-https.js')
    https.get({ host: 'example.com', path: '/' })
    await vi.waitFor(() => expect(connectCalls).toHaveLength(0))
    // waitFor above only proves it stays zero for one tick; a longer settle
    // confirms no delayed call sneaks in afterwards.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(connectCalls).toHaveLength(0)
  })

  it('createServer throws a named, explanatory error', async () => {
    installFakeOrivon()
    const https = await import('../node-https.js')
    expect(() => https.createServer()).toThrow(/net\.listen/)
  })
})
