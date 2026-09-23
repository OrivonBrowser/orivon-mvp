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
    // A177: OrivonHttpUnsupportedError now extends OrivonShimError, so a
    // catch block checking only the shared type still catches this one.
    const { OrivonShimError } = await import('../errors.js')
    try {
      http.createServer()
    } catch (error) {
      expect(error).toBeInstanceOf(OrivonShimError)
    }
  })

  it('surfaces a clear, named "error" event if window.orivon is absent when a request is attempted', async () => {
    const http = await import('../node-http.js')
    const req = http.get({ host: 'example.com', path: '/' })
    const error = await new Promise<Error>((resolve) => req.once('error', resolve))
    expect(error.message).toMatch(/window\.orivon/)
  })

  // A135: an unbuilt member read off the default export (a bundled CJS
  // `require('http')`'s own shape) used to be silently absent. A169:
  // reading one is now safe, the same as real absence; only calling it
  // still names the gap.
  it('reading an unbuilt member (validateHeaderName) on the default export is safe; calling it names the gap instead of leaving it absent', async () => {
    installFakeOrivon()
    const http = (await import('../node-http.js')).default as unknown as Record<string, () => unknown>
    const { OrivonShimError } = await import('../errors.js')
    expect(() => http.validateHeaderName).not.toThrow()
    expect(() => http.validateHeaderName!()).toThrow(OrivonShimError)
    try {
      http.validateHeaderName!()
    } catch (error) {
      expect((error as InstanceType<typeof OrivonShimError>).api).toBe('http.validateHeaderName')
    }
  })

  it('exports an Agent that can be constructed and subclassed, and a globalAgent that is one', async () => {
    installFakeOrivon()
    const http = await import('../node-http.js')
    class PoolingAgent extends http.Agent {
      constructor () { super({ keepAlive: true, maxSockets: 4 }) }
    }
    const agent = new PoolingAgent()
    expect(agent.keepAlive).toBe(true)
    expect(agent.maxSockets).toBe(4)
    expect(http.globalAgent).toBeInstanceOf(http.Agent)
    expect(http.default.Agent).toBe(http.Agent)
  })

  it('http.request(\'https://...\') throws ERR_INVALID_PROTOCOL instead of sending plaintext', async () => {
    const { connectCalls } = installFakeOrivon()
    const http = await import('../node-http.js')
    expect(() => http.request('https://example.com/')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_PROTOCOL' }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(connectCalls).toHaveLength(0)
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

  it('https.Agent extends http.Agent with https defaults', async () => {
    installFakeOrivon()
    const http = await import('../node-http.js')
    const https = await import('../node-https.js')
    const agent = new https.Agent()
    expect(agent).toBeInstanceOf(http.Agent)
    expect(agent.defaultPort).toBe(443)
    expect(https.globalAgent.protocol).toBe('https:')
  })

  it('the request\'s socket is a TLSSocket', async () => {
    installFakeOrivon()
    const https = await import('../node-https.js')
    const req = https.get({ host: 'example.com', path: '/' })
    const socket = await new Promise<{ encrypted?: boolean }>((resolve) => req.once('socket', resolve))
    expect(socket.encrypted).toBe(true)
    req.destroy()
    req.on('error', () => {})
  })

  it('passes the request\'s TLS options to connectSecure', async () => {
    const { connectSecureCalls } = installFakeOrivon()
    const https = await import('../node-https.js')
    const req = https.get({ host: 'self-signed.example', path: '/', ca: 'PEM', rejectUnauthorized: false })
    req.on('error', () => {})
    await vi.waitFor(() => expect(connectSecureCalls).toHaveLength(1))
    expect(connectSecureCalls[0]).toEqual({ host: 'self-signed.example', port: 443, ca: 'PEM', rejectUnauthorized: false })
    req.destroy()
  })

  it('merges the agent\'s TLS options over the request\'s, as Node does', async () => {
    const { connectSecureCalls } = installFakeOrivon()
    const https = await import('../node-https.js')
    const agent = new https.Agent({ ca: 'AGENT-PEM', keepAlive: true })
    const req = https.get({ host: 'example.com', path: '/', ca: 'REQUEST-PEM', servername: 'example.com', agent })
    req.on('error', () => {})
    await vi.waitFor(() => expect(connectSecureCalls).toHaveLength(1))
    expect(connectSecureCalls[0]).toEqual({ host: 'example.com', port: 443, ca: 'AGENT-PEM', servername: 'example.com' })
    req.destroy()
  })

  it('sends the Host header\'s name as SNI when it differs from the host, as Node\'s agent does', async () => {
    const { connectSecureCalls } = installFakeOrivon()
    const https = await import('../node-https.js')
    const named = https.get({ host: '203.0.113.7', path: '/', headers: { Host: 'api.example.com:8443' } })
    const unnamed = https.get({ host: 'api.example.com', path: '/', headers: { Host: '203.0.113.7' } })
    named.on('error', () => {})
    unnamed.on('error', () => {})
    await vi.waitFor(() => expect(connectSecureCalls).toHaveLength(2))
    expect(connectSecureCalls).toContainEqual({ host: '203.0.113.7', port: 443, servername: 'api.example.com' })
    expect(connectSecureCalls).toContainEqual({ host: 'api.example.com', port: 443, servername: '' })
    named.destroy()
    unnamed.destroy()
  })
})
