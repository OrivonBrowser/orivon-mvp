// node-tls.ts over a stubbed orivon.net.connectSecure -- the same
// globalThis.orivon pattern as node-http-https-modules.test.ts. The stub
// stands in for the broker, so what is proven here is the shim's half: which
// options reach connectSecure, and what the TLSSocket reports and enforces
// from the handshake facts it gets back.

import { afterEach, describe, expect, it, vi } from 'vitest'
// The page's Buffer (the `buffer` package, as the shim itself imports it), not Node's.
import { Buffer as PageBuffer } from 'buffer'
import { createFakeTcpSocket, type FakeTcpSocket } from './support/fake-tcp-socket.js'
import type { Orivon } from '../../contracts/capability-api.js'
import type { PeerCertificate, SecureHandshake } from '../../contracts/handles.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }

const CERT: PeerCertificate = {
  subject: { CN: 'electrum.example' },
  issuer: { CN: 'electrum.example' },
  subjectaltname: 'DNS:electrum.example',
  valid_from: 'Sep 23 00:00:00 2026 GMT',
  valid_to: 'Sep 23 00:00:00 2027 GMT',
  serialNumber: '0A',
  fingerprint: 'AA:BB',
  fingerprint256: 'CC:DD',
  raw: new Uint8Array([48, 130, 1]),
  pubkey: new Uint8Array([4, 5])
}

interface Installed { secureCalls: Array<Record<string, unknown>>, plainCalls: number, fake: FakeTcpSocket }

/** `facts` are the handshake facts the stubbed broker reports; `reject` makes connectSecure fail instead. */
function installFakeOrivon (facts: Partial<SecureHandshake> = {}, reject?: Error): Installed {
  const fake = createFakeTcpSocket({ remotePort: 50002 })
  const state: Installed = { secureCalls: [], plainCalls: 0, fake }
  ;(globalThis as GlobalWithOrivon).orivon = {
    net: {
      connect: async () => { state.plainCalls++; return fake.socket },
      connectSecure: async (opts: Record<string, unknown>) => {
        state.secureCalls.push(opts)
        if (reject !== undefined) throw reject
        return Object.assign(fake.socket, facts)
      }
    }
  } as unknown as Orivon
  return state
}

async function tlsModule (): Promise<typeof import('../node-tls.js')> {
  return await import('../node-tls.js')
}

function settled (socket: NodeJS.EventEmitter): Promise<'secureConnect' | Error> {
  return new Promise((resolve) => {
    socket.once('secureConnect', () => resolve('secureConnect'))
    socket.once('error', (error: Error) => resolve(error))
  })
}

afterEach(() => {
  delete (globalThis as GlobalWithOrivon).orivon
  vi.resetModules()
})

describe('tls.connect dials connectSecure with the app\'s options', () => {
  it('(port, host, cb) dials connectSecure, never plain connect, and fires cb on secureConnect after connect', async () => {
    const state = installFakeOrivon()
    const tls = await tlsModule()
    const order: string[] = []
    const socket = tls.connect(50002, 'electrum.example', () => order.push('cb'))
    socket.on('connect', () => order.push('connect'))
    socket.on('secureConnect', () => order.push('secureConnect'))
    await vi.waitFor(() => expect(order).toContain('cb'))
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

  it('translates Node\'s option shapes: Buffers become strings, ALPNProtocols becomes alpnProtocols', async () => {
    const state = installFakeOrivon({ alpnProtocol: 'h2' })
    const tls = await tlsModule()
    const socket = tls.connect(443, 'example.com', {
      ca: [Buffer.from('CA-PEM'), 'CA2'],
      cert: Buffer.from('CERT'),
      key: [{ pem: 'KEY', passphrase: 'pw' }],
      pfx: Buffer.from([1, 2, 3]),
      servername: 'EXAMPLE.com',
      rejectUnauthorized: false,
      ALPNProtocols: ['h2', Buffer.from('http/1.1')],
      minVersion: 'TLSv1.2'
    })
    expect(await settled(socket)).toBe('secureConnect')
    expect(state.secureCalls).toEqual([{
      host: 'example.com',
      port: 443,
      ca: ['CA-PEM', 'CA2'],
      cert: 'CERT',
      key: 'KEY',
      passphrase: 'pw',
      pfx: new Uint8Array([1, 2, 3]),
      servername: 'EXAMPLE.com',
      rejectUnauthorized: false,
      alpnProtocols: ['h2', 'http/1.1']
    }])
    expect(socket.alpnProtocol).toBe('h2')
    socket.destroy()
  })

  it('reads ALPNProtocols in wire format, and never sends an address as servername', async () => {
    const state = installFakeOrivon()
    const tls = await tlsModule()
    const wire = Buffer.from([2, 0x68, 0x32, 8, ...Buffer.from('http/1.1')])
    const socket = tls.connect({ host: '192.0.2.1', port: 443, servername: '192.0.2.1', ALPNProtocols: wire })
    expect(await settled(socket)).toBe('secureConnect')
    expect(state.secureCalls).toEqual([{ host: '192.0.2.1', port: 443, alpnProtocols: ['h2', 'http/1.1'] }])
    socket.destroy()
  })
})

describe('rejectUnauthorized: false really connects', () => {
  it('reports what verification found, and emits secureConnect', async () => {
    installFakeOrivon({ authorized: false, authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT', peerCertificate: CERT })
    const tls = await tlsModule()
    const socket = tls.connect({ host: 'electrum.example', port: 50002, rejectUnauthorized: false })

    expect(await settled(socket)).toBe('secureConnect')
    expect(socket.authorized).toBe(false)
    expect(socket.authorizationError).toBe('DEPTH_ZERO_SELF_SIGNED_CERT')
    socket.destroy()
  })

  it('a default-verified connection the broker refused surfaces its real code', async () => {
    const refusal = Object.assign(new Error('the secure connection failed'), { name: 'OrivonError', code: 'unreachable', platformCode: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
    installFakeOrivon({}, refusal)
    const tls = await tlsModule()
    const socket = tls.connect({ host: 'self-signed.example', port: 50002 })

    const outcome = await settled(socket)
    expect(outcome).toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
    expect((outcome as Error).message).not.toMatch(/not applied/)
  })
})

describe('getPeerCertificate', () => {
  it('returns the reported certificate in Node\'s shape, bytes as Buffers', async () => {
    installFakeOrivon({ authorized: true, peerCertificate: CERT })
    const tls = await tlsModule()
    const socket = tls.connect({ host: 'electrum.example', port: 50002 })
    await settled(socket)

    const cert = socket.getPeerCertificate(true) as Record<string, unknown>
    expect(cert).toMatchObject({ subject: { CN: 'electrum.example' }, fingerprint256: 'CC:DD', serialNumber: '0A', valid_to: CERT.valid_to })
    expect(PageBuffer.isBuffer(cert.raw)).toBe(true)
    expect([...(cert.raw as Buffer)]).toEqual([48, 130, 1])
    expect(PageBuffer.isBuffer(cert.pubkey)).toBe(true)
    socket.destroy()
    expect(socket.getPeerCertificate()).toBeNull()
  })
})

describe('checkServerIdentity runs in the shim, against the reported certificate, as Node runs it', () => {
  it('replaces the default hostname check: a chain-valid certificate for another name passes a lenient check', async () => {
    const state = installFakeOrivon({ authorized: false, authorizationError: 'ERR_TLS_CERT_ALTNAME_INVALID', peerCertificate: CERT })
    const tls = await tlsModule()
    const seen: Array<[string, Record<string, unknown>]> = []
    const socket = tls.connect({
      host: '203.0.113.7',
      port: 50002,
      servername: 'pinned.example',
      checkServerIdentity: (host: string, cert: Record<string, unknown>) => { seen.push([host, cert]); return undefined }
    })

    expect(await settled(socket)).toBe('secureConnect')
    expect(socket.authorized).toBe(true)
    // The broker is asked not to refuse on its default check; the shim decides.
    expect(state.secureCalls[0]).toMatchObject({ rejectUnauthorized: false })
    expect(seen[0]?.[0]).toBe('pinned.example')
    expect(PageBuffer.isBuffer(seen[0]?.[1].raw)).toBe(true)
    socket.destroy()
  })

  it('destroys the socket with the check\'s own error, and never writes a queued byte to the peer', async () => {
    const state = installFakeOrivon({ authorized: true, peerCertificate: CERT })
    const tls = await tlsModule()
    const pinError = Object.assign(new Error('fingerprint mismatch'), { code: 'ERR_PIN' })
    const socket = tls.connect({ host: 'electrum.example', port: 50002, checkServerIdentity: () => pinError })
    socket.write('secret request')
    let secured = false
    socket.on('secureConnect', () => { secured = true })

    const outcome = await new Promise<Error>((resolve) => socket.once('error', resolve))
    expect(outcome).toBe(pinError)
    expect(secured).toBe(false)
    expect(state.fake.written).toHaveLength(0)
    expect(state.fake.closed()).toBe(true)
  })

  it('a chain error decides before the check runs, as in Node', async () => {
    installFakeOrivon({ authorized: false, authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT', peerCertificate: CERT })
    const tls = await tlsModule()
    const check = vi.fn(() => undefined)
    const socket = tls.connect({ host: 'electrum.example', port: 50002, checkServerIdentity: check })

    expect(await settled(socket)).toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
    expect(check).not.toHaveBeenCalled()
  })

  it('with rejectUnauthorized: false a failing check is reported, not fatal', async () => {
    installFakeOrivon({ authorized: true, peerCertificate: CERT })
    const tls = await tlsModule()
    const socket = tls.connect({
      host: 'electrum.example',
      port: 50002,
      rejectUnauthorized: false,
      checkServerIdentity: () => Object.assign(new Error('nope'), { code: 'ERR_PIN' })
    })

    expect(await settled(socket)).toBe('secureConnect')
    expect(socket.authorized).toBe(false)
    expect(socket.authorizationError).toBe('ERR_PIN')
    socket.destroy()
  })

  it('tls.checkServerIdentity is exported for a custom check to call', async () => {
    installFakeOrivon()
    const tls = await tlsModule()
    expect(tls.checkServerIdentity('electrum.example', CERT)).toBeUndefined()
    expect(tls.checkServerIdentity('other.example', CERT)).toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
    expect(typeof (tls.default as unknown as Record<string, unknown>).checkServerIdentity).toBe('function')
  })
})

describe('what cannot cross to the broker refuses by name, without dialling', () => {
  it.each([
    ['socket (STARTTLS)', { socket: {} }, /STARTTLS/],
    ['secureContext', { secureContext: {} }, /secureContext/],
    ['a two-entry cert array', { cert: ['A', 'B'], key: 'K' }, /'cert' shape/],
    ['a checkServerIdentity that is not a function', { checkServerIdentity: 'yes' }, /checkServerIdentity/]
  ])('%s', async (_label, extra, message) => {
    const state = installFakeOrivon()
    const tls = await tlsModule()
    const socket = tls.connect({ host: 'electrum.example', port: 50002, ...extra })
    const error = await new Promise<Error>((resolve) => socket.once('error', resolve))
    expect(error).toMatchObject({ name: 'OrivonShimError', reason: 'unimplemented' })
    expect(error.message).toMatch(message)
    expect(state.secureCalls).toHaveLength(0)
  })

  it('new TLSSocket(existingSocket) refuses by name', async () => {
    installFakeOrivon()
    const tls = await tlsModule()
    expect(() => new tls.TLSSocket({})).toThrow(/wrapping an existing socket/)
  })

  it('the default export names any other member when called', async () => {
    installFakeOrivon()
    const tls = (await tlsModule()).default as unknown as Record<string, (...args: unknown[]) => unknown>
    expect(typeof tls.connect).toBe('function')
    expect(() => tls.createSecureContext!({})).toThrow(/tls\.createSecureContext/)
  })
})
