import { describe, expect, it } from 'vitest'
import { BUILTIN_ADDRESSES } from '../../../../protocols/builtin.js'
import { exceptionCanaries } from '../canaries.js'
import { mirroredConfig, mirroredScriptConfig, routedBypassRules } from '../mirrored-config.js'
import { runPac } from './pac-vm.test-helpers.js'

describe('the rules that keep a name the verifier serves from a proxy', () => {
  it('name every routed suffix as the resolver rules map it, and no root-dot spelling, which they do not match', () => {
    const rules = routedBypassRules()
    expect(rules).toEqual(BUILTIN_ADDRESSES.routedSuffixes().map((suffix) => `*.${suffix}`))
    expect(rules).toContain('*.eth')
    expect(rules.filter((rule) => rule.endsWith('.'))).toEqual([])
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

  it.each(['none', 'detect', 'unsupported', 'unreadable'] as const)('is nothing for settings that are %s, so the sessions stay on the system\'s own', (kind) => {
    expect(mirroredConfig({ kind })).toBeUndefined()
  })

  it('is nothing for a script, whose config is made from its text once it is fetched', () => {
    expect(mirroredConfig({ kind: 'script', url: 'http://wpad.test/proxy.pac' })).toBeUndefined()
  })
})

describe('the mirrored config of a proxy script', () => {
  const SCRIPT = 'function FindProxyForURL(url, host) { return "PROXY proxy.test:3128" }'

  /** The text of the script a session is set to, from its `data:` address. */
  function sourceOf (pacScript: string | undefined): string {
    const [head, body] = (pacScript ?? '').split(',')
    expect(head).toBe('data:application/x-ns-proxy-autoconfig;base64')
    return Buffer.from(body ?? '', 'base64').toString('latin1')
  }

  it('is a script of Orivon\'s own, set by its data address and not by the address the system names', () => {
    const config = mirroredScriptConfig(SCRIPT)
    expect(config.mode).toBe('pac_script')
    expect(Object.keys(config).sort()).toEqual(['mode', 'pacScript'])
    expect(sourceOf(config.pacScript)).not.toBe(SCRIPT)
  })

  it('gives the system\'s answer for an ordinary name and DIRECT for every name the verifier serves, with or without a root dot', () => {
    const { answer } = runPac(sourceOf(mirroredScriptConfig(SCRIPT).pacScript))
    expect(answer('https://ordinary.test/')).toBe('PROXY proxy.test:3128')
    for (const suffix of BUILTIN_ADDRESSES.routedSuffixes()) {
      for (const dots of ['', '.', '..']) expect(answer(`https://name.${suffix}${dots}/`)).toBe('DIRECT')
    }
  })

  it('names the same suffixes as the rules for a manual proxy', () => {
    const { answer } = runPac(sourceOf(mirroredScriptConfig(SCRIPT).pacScript))
    for (const rule of routedBypassRules()) expect(answer(`https://name${rule.slice(1)}/`)).toBe('DIRECT')
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
