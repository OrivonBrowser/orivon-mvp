import { describe, expect, it } from 'vitest'
import { X509Certificate, createHash, createPrivateKey } from 'node:crypto'
import { connect, createServer } from 'node:tls'
import type { AddressInfo } from 'node:net'
import { createRunCertificate } from '../certificate.js'

describe('createRunCertificate', () => {
  const run = createRunCertificate(new Date('2026-09-24T12:00:00Z'))
  const cert = new X509Certificate(run.certPem)

  it('is a self-signed certificate Node parses, whose signature verifies with its own key', () => {
    expect(cert.verify(cert.publicKey)).toBe(true)
    expect(cert.checkPrivateKey(createPrivateKey(run.keyPem))).toBe(true)
    expect(cert.subject).toBe('CN=Orivon .eth verifier')
    expect(cert.issuer).toBe(cert.subject)
    expect(cert.subjectAltName).toBe('DNS:*.eth')
  })

  it('is valid from a minute before now for the requested days', () => {
    expect(new Date(cert.validFrom).toISOString()).toBe('2026-09-24T11:59:00.000Z')
    expect(new Date(cert.validTo).toISOString()).toBe('2026-10-24T12:00:00.000Z')
  })

  it('reports the fingerprint in the form Electron gives a verify proc', () => {
    expect(run.fingerprint).toBe(`sha256/${createHash('sha256').update(cert.raw).digest('base64')}`)
  })

  it('uses GeneralizedTime past 2049', () => {
    const late = new X509Certificate(createRunCertificate(new Date('2049-12-20T00:00:00Z'), 30).certPem)
    expect(new Date(late.validTo).getUTCFullYear()).toBe(2050)
  })

  it('is different every run', () => {
    expect(createRunCertificate().fingerprint).not.toBe(run.fingerprint)
  })

  it('completes a real TLS handshake, pinned by fingerprint', async () => {
    const server = createServer({ key: run.keyPem, cert: run.certPem }, (socket) => { socket.end('ok') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    try {
      const seen = await new Promise<string>((resolve, reject) => {
        const socket = connect({ port, host: '127.0.0.1', servername: 'vitalik.eth', rejectUnauthorized: false }, () => {
          resolve(socket.getPeerX509Certificate()?.fingerprint256 ?? '')
          socket.end()
        })
        socket.on('error', reject)
      })
      expect(seen).toBe(cert.fingerprint256)
    } finally {
      server.close()
    }
  })
})
