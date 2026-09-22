// node-tls.ts over a stubbed orivon.net.connectSecure -- the same
// globalThis.orivon pattern as node-http-https-modules.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeTcpSocket } from './support/fake-tcp-socket.js'
import type { Orivon } from '../../contracts/capability-api.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }

function installFakeOrivon (connectSecure?: (opts: { host: string, port: number }) => Promise<unknown>): { secureCalls: Array<{ host: string, port: number }>, plainCalls: number } {
  const secureCalls: Array<{ host: string, port: number }> = []
  const state = { secureCalls, plainCalls: 0 }
  const fake = createFakeTcpSocket({ remotePort: 50002 })
  ;(globalThis as GlobalWithOrivon).orivon = {
    net: {
      connect: async () => { state.plainCalls++; return fake.socket },
      connectSecure: async (opts: { host: string, port: number }) => {
        secureCalls.push(opts)
        return connectSecure !== undefined ? await connectSecure(opts) : fake.socket
      }
    }
  } as unknown as Orivon
  return state
}

afterEach(() => {
  delete (globalThis as GlobalWithOrivon).orivon
  vi.resetModules()
})

describe('tls.connect', () => {
  it('(port, host, cb) dials connectSecure, never plain connect, and fires cb on secureConnect after connect', async () => {
    const state = installFakeOrivon()
    const tls = await import('../node-tls.js')
    const order: string[] = []
    const socket = tls.connect(50002, 'electrum.example', () => order.push('cb'))
    socket.on('connect', () => order.push('connect'))
    socket.on('secureConnect', () => order.push('secureConnect'))
    await vi.waitFor(() => expect(order).toContain('cb'))
    // cb was registered on 'secureConnect' before this test's own listener.
    expect(order).toEqual(['connect', 'cb', 'secureConnect'])
    expect(state.secureCalls).toEqual([{ host: 'electrum.example', port: 50002 }])
    expect(state.plainCalls).toBe(0)
    expect(socket.encrypted).toBe(true)
    expect(socket.authorized).toBe(true)
    expect(socket.servername).toBe('electrum.example')
    expect(socket.getPeerCertificate()).toEqual({})
    expect(socket.alpnProtocol).toBe(false)
    socket.destroy()
  })

  it('merges a third-position options object, and accepts servername equal to the host and ALPNProtocols', async () => {
    const state = installFakeOrivon()
    const tls = await import('../node-tls.js')
    const socket = tls.connect(443, 'example.com', { servername: 'EXAMPLE.com', ALPNProtocols: ['http/1.1'], minVersion: 'TLSv1.2' })
    await new Promise<void>((resolve) => socket.once('secureConnect', resolve))
    expect(state.secureCalls).toEqual([{ host: 'example.com', port: 443 }])
    socket.destroy()
  })

  it.each([
    ['ca', { ca: '-----BEGIN CERTIFICATE-----' }],
    ['cert', { cert: 'x', key: 'y' }],
    ['checkServerIdentity', { checkServerIdentity: () => undefined }],
    ['socket', { socket: {} }],
    ['servername', { servername: 'other.example' }]
  ])('refuses %s by name through "error", without dialling', async (_label, extra) => {
    const state = installFakeOrivon()
    const tls = await import('../node-tls.js')
    const socket = tls.connect({ host: 'self-signed.example', port: 50002, ...extra })
    const error = await new Promise<unknown>((resolve) => socket.once('error', resolve))
    // vi.resetModules() gives each test a fresh errors module, so match by shape, not class identity.
    expect(error).toMatchObject({ name: 'OrivonShimError', reason: 'unimplemented' })
    expect((error as Error).message).toMatch(/system trust store/)
    expect(state.secureCalls).toHaveLength(0)
  })

  it('rejectUnauthorized: false still dials with verification on, and a failed handshake says the override was not applied', async () => {
    installFakeOrivon(async () => {
      throw Object.assign(new Error('self-signed certificate'), { name: 'OrivonError', code: 'unreachable', platformCode: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
    })
    const tls = await import('../node-tls.js')
    const socket = tls.connect({ host: 'self-signed.example', port: 50002, rejectUnauthorized: false })
    const error = await new Promise<Error & { code?: string }>((resolve) => socket.once('error', resolve))
    expect(error.code).toBe('DEPTH_ZERO_SELF_SIGNED_CERT')
    expect(error.message).toMatch(/rejectUnauthorized: false was not applied/)
  })

  it('new TLSSocket(existingSocket) refuses by name', async () => {
    installFakeOrivon()
    const tls = await import('../node-tls.js')
    expect(() => new tls.TLSSocket({})).toThrow(/wrapping an existing socket/)
  })

  it('the default export carries connect/TLSSocket and names any other member when called', async () => {
    installFakeOrivon()
    const tls = (await import('../node-tls.js')).default as unknown as Record<string, (...args: unknown[]) => unknown>
    expect(typeof tls.connect).toBe('function')
    expect(() => tls.createSecureContext!({})).toThrow(/tls\.createSecureContext/)
  })
})
