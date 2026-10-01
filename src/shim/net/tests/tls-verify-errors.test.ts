// vitest runs in Node, so a real `node:tls` handshake is the oracle: the
// shim's error for a verification code must read exactly as Node's does.

import { connect, createServer } from 'node:tls'
import type { Server } from 'node:tls'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateSelfSignedFixture, generateTlsFixture } from '../../../broker/adapters/tests/tls-adapter.test-helpers.js'
import { isVerificationCode, verificationError } from '../tls-verify-errors.js'

/** Node 24 appends a hint naming its own --use-system-ca flag to some codes; the shim leaves it out. */
function withoutNodeFlagHint (message: string): string {
  return message.replace(/; if the root CA is installed locally, .*$/, '')
}

function nodeVerificationFailure (port: number): Promise<Error & { code: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port, servername: 'localhost' })
    socket.once('secureConnect', () => { socket.destroy(); reject(new Error('verification passed')) })
    socket.once('error', resolve)
  })
}

function listen (cert: string, key: string): Promise<Server> {
  const server = createServer({ cert, key }, (socket) => socket.destroy())
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

describe('verificationError matches Node over a real handshake', () => {
  const ports: number[] = []
  const servers: Server[] = []

  beforeAll(async () => {
    const selfSigned = generateSelfSignedFixture()
    const issued = generateTlsFixture()
    for (const [cert, key] of [[selfSigned.cert, selfSigned.key], [issued.leafCert, issued.leafKey]] as const) {
      const server = await listen(cert, key)
      servers.push(server)
      ports.push((server.address() as AddressInfo).port)
    }
  })

  afterAll(() => { for (const server of servers) server.close() })

  it.each([
    ['a self-signed certificate', 0, 'DEPTH_ZERO_SELF_SIGNED_CERT'],
    ['a leaf whose issuer is not trusted', 1, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']
  ])('%s', async (_name, server, expectedCode) => {
    const node = await nodeVerificationFailure(ports[server] ?? 0)
    expect(node.code).toBe(expectedCode)
    const shim = verificationError(node.code)
    expect(shim.code).toBe(node.code)
    expect(String(shim)).toBe(withoutNodeFlagHint(String(node)))
  })
})

describe('isVerificationCode', () => {
  it('names the certificate codes Node reports, and the hostname mismatch', () => {
    expect(isVerificationCode('CERT_HAS_EXPIRED')).toBe(true)
    expect(isVerificationCode('ERR_TLS_CERT_ALTNAME_INVALID')).toBe(true)
  })

  it('leaves network errors, inherited names and non-strings to the ordinary mapping', () => {
    expect(isVerificationCode('ECONNREFUSED')).toBe(false)
    expect(isVerificationCode('toString')).toBe(false)
    expect(isVerificationCode(undefined)).toBe(false)
  })
})

it('an unknown code still names itself', () => {
  expect(verificationError('SOMETHING_NEW').message).toBe('certificate verification failed: SOMETHING_NEW')
})
