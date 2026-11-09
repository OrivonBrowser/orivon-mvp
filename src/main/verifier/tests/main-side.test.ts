import { describe, expect, it } from 'vitest'
import { createServer } from 'node:net'
import { BUILTIN_ADDRESSES } from '../../../protocols/builtin.js'
import { ACCEPT, CHROMIUM_VERDICT, REJECT, refusalNote, verifierCertificateVerdict } from '../certificate-check.js'
import { loopbackPort } from '../loopback-port.js'
import { answerNamesHere, composeResolverRules } from '../resolver-rules.js'

describe('composeResolverRules', () => {
  const suffixes = BUILTIN_ADDRESSES.routedSuffixes()
  const ONION = 'MAP *.onion ~NOTFOUND,MAP *.onion. ~NOTFOUND,MAP onion ~NOTFOUND'
  const ROOT_DOT = 'MAP *.eth. ~NOTFOUND,MAP *.eth..* ~NOTFOUND,MAP *.orivon. ~NOTFOUND,MAP *.orivon..* ~NOTFOUND'
  /** Chromium's `MatchPattern` over a host: `*` is any run of characters, `?` one, everything else itself. */
  const matches = (host: string, pattern: string): boolean => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(host)
  const patternOf = (clause: string): string => clause.split(' ')[1] ?? ''

  it('puts developer names first, then every protocol host, then the rules already given', () => {
    expect(composeResolverRules({ devClauses: 'MAP freetube.eth 127.0.0.1:8875', port: 40001, suffixes, existing: 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1' }))
      .toBe('MAP freetube.eth 127.0.0.1:8875,MAP *.eth 127.0.0.1:40001,MAP *.orivon 127.0.0.1:40001,MAP *.localhost 127.0.0.1,MAP * ~NOTFOUND, EXCLUDE 127.0.0.1,' + ONION + ',' + ROOT_DOT)
  })

  it('maps every .localhost name to the IPv4 loopback address, ahead of any rule already given, so a page under one never reaches an IPv6 server', () => {
    const rules = composeResolverRules({ devClauses: '', port: 40001, suffixes, existing: 'MAP * ~NOTFOUND' })
    expect(rules.indexOf('MAP *.localhost 127.0.0.1')).toBeGreaterThan(-1)
    expect(rules.indexOf('MAP *.localhost 127.0.0.1')).toBeLessThan(rules.indexOf('MAP * ~NOTFOUND'))
  })

  it('is the protocol clauses and the localhost clause when nothing else is given, and the localhost clause even with no suffix', () => {
    expect(composeResolverRules({ devClauses: '', port: 40001, suffixes, existing: '' }))
      .toBe('MAP *.eth 127.0.0.1:40001,MAP *.orivon 127.0.0.1:40001,MAP *.localhost 127.0.0.1,' + ONION + ',' + ROOT_DOT)
    expect(composeResolverRules({ devClauses: '', port: 40001, suffixes: [], existing: '' })).toBe('MAP *.localhost 127.0.0.1,' + ONION)
  })

  it('refuses every onion name after the rules already given, so no resolver is asked for one and a rule of a test run still wins', () => {
    const rules = composeResolverRules({ devClauses: '', port: 40001, suffixes, existing: 'MAP abc.onion 127.0.0.1:9' })
    expect(rules).toContain(ONION)
    expect(rules.indexOf('MAP abc.onion 127.0.0.1:9')).toBeLessThan(rules.indexOf('MAP *.onion ~NOTFOUND'))
  })

  it('refuses the root-dot spelling of every protocol host, which the clause that serves the name does not match, and leaves the dotless spelling to the verifier', () => {
    const clauses = composeResolverRules({ devClauses: '', port: 40001, suffixes, existing: '' }).split(',')
    for (const suffix of suffixes) {
      expect(clauses).toContain(`MAP *.${suffix}. ~NOTFOUND`)
      expect(clauses).toContain(`MAP *.${suffix}..* ~NOTFOUND`)
      const served = patternOf(clauses.find((clause) => clause.startsWith(`MAP *.${suffix} `)) ?? '')
      const refused = patternOf(`MAP *.${suffix}. ~NOTFOUND`)
      expect(matches(`vitalik.${suffix}.`, refused)).toBe(true)
      expect(matches(`vitalik.${suffix}.`, served)).toBe(false)
      expect(matches(`vitalik.${suffix}`, served)).toBe(true)
      expect(matches(`vitalik.${suffix}`, refused)).toBe(false)
    }
  })

  it('refuses a protocol host with more than one trailing dot too, and no valid name', () => {
    const clauses = composeResolverRules({ devClauses: '', port: 40001, suffixes, existing: '' }).split(',')
    const refused = patternOf('MAP *.eth..* ~NOTFOUND')
    expect(clauses).toContain('MAP *.eth..* ~NOTFOUND')
    for (const host of ['vitalik.eth..', 'vitalik.eth...', 'a.b.eth..']) expect(matches(host, refused), host).toBe(true)
    for (const host of ['vitalik.eth', 'vitalik.eth.', 'www.eth.example.com', 'eth.example.org', 'vitalik.ethereum', 'vitalik.eth.example.eth']) expect(matches(host, refused), host).toBe(false)
  })

  it('writes the root-dot refusals after the rules already given, as it does the onion ones, and with no protocol host there are none', () => {
    const rules = composeResolverRules({ devClauses: '', port: 40001, suffixes, existing: 'MAP vitalik.eth. 127.0.0.1:9' })
    expect(rules.indexOf('MAP vitalik.eth. 127.0.0.1:9')).toBeLessThan(rules.indexOf('MAP *.eth. ~NOTFOUND'))
    expect(composeResolverRules({ devClauses: '', port: 40001, suffixes: [], existing: '' }).split(',').filter((clause) => clause.endsWith('. ~NOTFOUND'))).toEqual(['MAP *.onion. ~NOTFOUND'])
  })
})

describe('answerNamesHere', () => {
  const suffixes = BUILTIN_ADDRESSES.routedSuffixes()

  it('sets the resolver rules after the ones already given and exempts the names from an environment proxy', () => {
    const switches = new Map([['host-resolver-rules', 'MAP test.example 127.0.0.1']])
    const env: Record<string, string | undefined> = { http_proxy: 'http://127.0.0.1:3128', no_proxy: 'localhost' }
    answerNamesHere({ getSwitchValue: (name) => switches.get(name) ?? '', appendSwitch: (name, value) => { switches.set(name, value) } }, env, { devClauses: '', port: 40001, suffixes })
    expect(switches.get('host-resolver-rules')).toContain('MAP *.eth 127.0.0.1:40001')
    expect(switches.get('host-resolver-rules')).toContain('MAP test.example 127.0.0.1')
    expect(env.no_proxy).toBe('localhost,.eth,.orivon')
    expect(env.NO_PROXY).toBe('localhost,.eth,.orivon')
    expect(env.http_proxy).toBe('http://127.0.0.1:3128')
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

describe('refusalNote', () => {
  it('names the host, both fingerprints cut short, and the host process state', () => {
    expect(refusalNote('app.eth', 'sha256/AAAABBBBCCCCDDDDEEEEFFFF=', 'sha256/ZZZZYYYYXXXXWWWWVVVV=', 'running'))
      .toBe("[verifier] refused certificate AAAABBBBCCCCDDDD for app.eth: the verifier's is ZZZZYYYYXXXXWWWW (host running)")
  })

  it('says when no verifier certificate was known yet', () => {
    expect(refusalNote('app.eth', 'sha256/AAAABBBBCCCCDDDDEEEE=', undefined, 'asleep'))
      .toBe('[verifier] refused certificate AAAABBBBCCCCDDDD for app.eth: no verifier certificate was known (host asleep)')
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
