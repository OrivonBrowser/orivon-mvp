import { describe, expect, it } from 'vitest'
import { createServer } from 'node:net'
import { BUILTIN_ADDRESSES } from '../../../protocols/builtin.js'
import { ACCEPT, CHROMIUM_VERDICT, REJECT, verifierCertificateVerdict } from '../certificate-check.js'
import { loopbackPort } from '../loopback-port.js'
import { composeResolverRules } from '../resolver-rules.js'

describe('composeResolverRules', () => {
  const suffixes = BUILTIN_ADDRESSES.routedSuffixes()

  it('puts developer names first, then every protocol host, then the rules already given', () => {
    expect(composeResolverRules({ devClauses: 'MAP freetube.eth 127.0.0.1:8875', port: 40001, suffixes, existing: 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1' }))
      .toBe('MAP freetube.eth 127.0.0.1:8875,MAP *.eth 127.0.0.1:40001,MAP *.orivon 127.0.0.1:40001,MAP *.localhost 127.0.0.1,MAP * ~NOTFOUND, EXCLUDE 127.0.0.1')
  })

  it('maps every .localhost name to the IPv4 loopback address, ahead of any rule already given, so a page under one never reaches an IPv6 server', () => {
    const rules = composeResolverRules({ devClauses: '', port: 40001, suffixes, existing: 'MAP * ~NOTFOUND' })
    expect(rules.indexOf('MAP *.localhost 127.0.0.1')).toBeGreaterThan(-1)
    expect(rules.indexOf('MAP *.localhost 127.0.0.1')).toBeLessThan(rules.indexOf('MAP * ~NOTFOUND'))
  })

  it('is the protocol clauses and the localhost clause when nothing else is given, and the localhost clause even with no suffix', () => {
    expect(composeResolverRules({ devClauses: '', port: 40001, suffixes, existing: '' }))
      .toBe('MAP *.eth 127.0.0.1:40001,MAP *.orivon 127.0.0.1:40001,MAP *.localhost 127.0.0.1')
    expect(composeResolverRules({ devClauses: '', port: 40001, suffixes: [], existing: '' })).toBe('MAP *.localhost 127.0.0.1')
  })
})

describe('verifierCertificateVerdict', () => {
  const RUN = 'sha256/abc='
  const routed = (host: string): boolean => BUILTIN_ADDRESSES.routesToVerifier(host)
  const verdict = (host: string, fingerprint: string, expected: string | undefined): number => verifierCertificateVerdict(host, fingerprint, expected, routed)

  it("accepts a .eth or address host only with the run's fingerprint", () => {
    expect(verdict('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.ipfs.orivon', RUN, RUN)).toBe(ACCEPT)
    expect(verdict('ipfs.orivon', 'sha256/other=', RUN)).toBe(REJECT)
    expect(verdict('vitalik.eth', RUN, RUN)).toBe(ACCEPT)
    expect(verdict('Vitalik.ETH', RUN, RUN)).toBe(ACCEPT)
    expect(verdict('vitalik.eth', 'sha256/other=', RUN)).toBe(REJECT)
  })

  it('rejects every .eth host before the verifier has reported a certificate', () => {
    expect(verdict('vitalik.eth', RUN, undefined)).toBe(REJECT)
  })

  it("leaves every other host to Chromium's own verdict, even with the run's certificate", () => {
    expect(verdict('example.com', RUN, RUN)).toBe(CHROMIUM_VERDICT)
    expect(verdict('eth.example.com', RUN, RUN)).toBe(CHROMIUM_VERDICT)
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
