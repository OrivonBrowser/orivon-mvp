import { describe, expect, it } from 'vitest'
import { createServer } from 'node:net'
import { ACCEPT, CHROMIUM_VERDICT, REJECT, ethCertificateVerdict } from '../certificate-check.js'
import { loopbackPort } from '../loopback-port.js'
import { composeResolverRules } from '../resolver-rules.js'

describe('composeResolverRules', () => {
  it('puts developer names first, then every .eth name, then the rules already given', () => {
    expect(composeResolverRules({ devClauses: 'MAP freetube.eth 127.0.0.1:8875', port: 40001, existing: 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1' }))
      .toBe('MAP freetube.eth 127.0.0.1:8875,MAP *.eth 127.0.0.1:40001,MAP * ~NOTFOUND, EXCLUDE 127.0.0.1')
  })

  it('is the .eth clause alone when nothing else is given', () => {
    expect(composeResolverRules({ devClauses: '', port: 40001, existing: '' })).toBe('MAP *.eth 127.0.0.1:40001')
  })
})

describe('ethCertificateVerdict', () => {
  const RUN = 'sha256/abc='

  it("accepts a .eth host only with the run's fingerprint", () => {
    expect(ethCertificateVerdict('vitalik.eth', RUN, RUN)).toBe(ACCEPT)
    expect(ethCertificateVerdict('Vitalik.ETH', RUN, RUN)).toBe(ACCEPT)
    expect(ethCertificateVerdict('vitalik.eth', 'sha256/other=', RUN)).toBe(REJECT)
  })

  it('rejects every .eth host before the verifier has reported a certificate', () => {
    expect(ethCertificateVerdict('vitalik.eth', RUN, undefined)).toBe(REJECT)
  })

  it("leaves every other host to Chromium's own verdict, even with the run's certificate", () => {
    expect(ethCertificateVerdict('example.com', RUN, RUN)).toBe(CHROMIUM_VERDICT)
    expect(ethCertificateVerdict('eth.example.com', RUN, RUN)).toBe(CHROMIUM_VERDICT)
  })
})

describe('loopbackPort', () => {
  it('returns one free port, the same every call', async () => {
    const port = loopbackPort()
    expect(loopbackPort()).toBe(port)
    const server = createServer()
    await new Promise<void>((resolve, reject) => { server.once('error', reject).listen(port, '127.0.0.1', resolve) })
    server.close()
  })
})
