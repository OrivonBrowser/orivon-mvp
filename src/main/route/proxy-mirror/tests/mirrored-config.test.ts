import { describe, expect, it } from 'vitest'
import { BUILTIN_ADDRESSES } from '../../../../protocols/builtin.js'
import { exceptionCanaries } from '../canaries.js'
import { mirroredConfig } from '../mirrored-config.js'
import { routedBypassRules } from '../../verifier-name-guard.js'

describe('the rules that keep a name the verifier serves from a proxy', () => {
  it('name every routed suffix as the resolver rules map it, and its root-dot spelling, which they refuse', () => {
    const rules = routedBypassRules()
    expect(rules).toEqual(BUILTIN_ADDRESSES.routedSuffixes().flatMap((suffix) => [`*.${suffix}`, `*.${suffix}.`]))
    expect(rules).toContain('*.eth')
    expect(rules).toContain('*.eth.')
  })
})

describe('the mirrored config', () => {
  it('is the system\'s rules, then its exceptions, then the rules for the names the verifier serves', () => {
    const config = mirroredConfig({ kind: 'manual', proxyRules: 'http=proxy.test:3128', exceptions: ['localhost', '*.corp.test'] })
    expect(config).toEqual({ mode: 'fixed_servers', proxyRules: 'http=proxy.test:3128', proxyBypassRules: ['localhost', '*.corp.test', ...routedBypassRules()].join(';') })
  })

  it('keeps the routed rules when the system lists no exception', () => {
    expect(mirroredConfig({ kind: 'manual', proxyRules: 'http=proxy.test:3128', exceptions: [] })?.proxyBypassRules).toBe(routedBypassRules().join(';'))
  })

  it.each(['none', 'script', 'detect', 'unsupported', 'unreadable'] as const)('is nothing for settings that are %s, so the sessions stay on the system\'s own', (kind) => {
    expect(mirroredConfig({ kind })).toBeUndefined()
  })
})

describe('the addresses an exception covers', () => {
  it('are made from a suffix, a name and an address, at most three, in the list\'s order', () => {
    expect(exceptionCanaries(['*.corp.test', '.lan', 'intranet', '10.0.0.0/8', '192.168.1.5'])).toEqual(['https://probe.corp.test/', 'https://probe.lan/', 'https://intranet/'])
    expect(exceptionCanaries(['10.0.0.0/8', '192.168.1.5'])).toEqual(['https://10.0.0.0/', 'https://192.168.1.5/'])
  })

  it('leave out what a plain question shows nothing of: this machine, a port, a pattern for every host, an IPv6 range', () => {
    expect(exceptionCanaries(['localhost', '127.0.0.0/8', '[::1]', '<local>', '*', 'example.com:443', '2001:db8::/32', '169.254.0.0/16', '999.1.1.1'])).toEqual([])
  })

  it('are listed once', () => {
    expect(exceptionCanaries(['*.corp.test', '.corp.test', 'corp.test'])).toEqual(['https://probe.corp.test/', 'https://corp.test/'])
  })
})
