// net.connectSecure's TLS options and handshake facts across CONTROL_CHANNEL:
// the validated options reach the broker, a malformed one never does, and the
// reply carries what the handshake established for the preload to hand the
// page. The byte relay itself is ipc.test.ts's, shared with net.connect.

import { describe, expect, it } from 'vitest'
import { handleControlRequest } from '../ipc.js'
import type { FailableSecureTcpSocket } from '../../broker-contracts.js'
import { APP, type BrokerCall, envelope, fakePortPair, fakeTcpSocket, fakeTransport, frameFor, stubBroker } from './ipc.test-helpers.js'

const CERT = {
  subject: { CN: 'electrum.example' },
  issuer: { CN: 'electrum.example' },
  subjectaltname: 'DNS:electrum.example',
  valid_from: 'Sep 23 00:00:00 2026 GMT',
  valid_to: 'Sep 23 00:00:00 2027 GMT',
  serialNumber: '01',
  fingerprint: 'AA',
  fingerprint256: 'BB',
  raw: new Uint8Array([48, 1, 2])
}

function secureSocket (): FailableSecureTcpSocket {
  return Object.assign(fakeTcpSocket().socket, {
    authorized: false,
    authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    alpnProtocol: 'h2' as const,
    peerCertificate: CERT
  })
}

describe('net.connectSecure carries TLS options in and handshake facts out', () => {
  it('hands the broker the validated options, and nothing it did not recognise', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { connectSecure: async () => secureSocket() })
    const options = { host: 'electrum.example', port: 50002, rejectUnauthorized: false, ca: 'PEM', alpnProtocols: ['h2'], servername: undefined }

    const response = await handleControlRequest(broker, frameFor(APP), envelope('net.connectSecure', options), fakeTransport(fakePortPair().pair))

    expect(response.ok).toBe(true)
    expect(calls).toEqual([{
      method: 'net.connectSecure',
      origin: APP,
      args: { host: 'electrum.example', port: 50002, rejectUnauthorized: false, ca: 'PEM', alpnProtocols: ['h2'] }
    }])
  })

  it('replies with the socket descriptor plus the handshake facts', async () => {
    const broker = stubBroker([], { connectSecure: async () => secureSocket() })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('net.connectSecure', { host: 'electrum.example', port: 50002 }), fakeTransport(fakePortPair().pair))

    expect(response).toEqual({
      id: 'req-1',
      ok: true,
      result: {
        id: 'handle-1',
        remoteAddress: '93.184.216.34',
        remotePort: 443,
        localAddress: '10.0.0.5',
        localPort: 54321,
        tls: { authorized: false, authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT', alpnProtocol: 'h2', peerCertificate: CERT }
      }
    })
  })

  it('refuses a malformed option as invalid, naming it, without calling the broker', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { connectSecure: async () => secureSocket() })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('net.connectSecure', { host: 'a.example', port: 443, key: 42 }), fakeTransport(fakePortPair().pair))

    expect(response).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/key/) })
    expect(calls).toEqual([])
  })

  it('net.connect replies with no handshake facts at all', async () => {
    const broker = stubBroker([], { connect: async () => fakeTcpSocket().socket })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('net.connect', { host: 'a.example', port: 80 }), fakeTransport(fakePortPair().pair))

    expect(response.ok && 'tls' in (response.result as object)).toBe(false)
  })
})
