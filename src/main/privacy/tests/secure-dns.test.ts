import { describe, expect, it, vi } from 'vitest'
import { applySecureDns, effectiveSecureDns, needsResolverCall, secureDnsForcedOff, secureDnsOptions } from '../secure-dns.js'
import { SETTINGS } from '../../settings/schema.js'

describe('secureDnsOptions', () => {
  it('turns the provider choices into secure mode with that provider\'s template', () => {
    expect(secureDnsOptions('cloudflare', 'linux')).toEqual({ secureDnsMode: 'secure', secureDnsServers: ['https://cloudflare-dns.com/dns-query'], enableBuiltInResolver: true })
    expect(secureDnsOptions('quad9', 'win32')).toEqual({ secureDnsMode: 'secure', secureDnsServers: ['https://dns.quad9.net/dns-query'], enableBuiltInResolver: true })
  })

  it('asks Quad9 first and falls back to the computer\'s own DNS for the default', () => {
    expect(SETTINGS['privacy.secureDns'].default).toBe('quad9Fallback')
    expect(secureDnsOptions('quad9Fallback', 'linux')).toEqual({ secureDnsMode: 'automatic', secureDnsServers: ['https://dns.quad9.net/dns-query'], enableBuiltInResolver: true })
  })

  it('leaves the provider to the resolver in automatic mode', () => {
    expect(secureDnsOptions('automatic', 'linux')).toEqual({ secureDnsMode: 'automatic', enableBuiltInResolver: true })
  })

  it('puts the resolver back to the platform\'s default when off', () => {
    expect(secureDnsOptions('off', 'linux')).toEqual({ secureDnsMode: 'off', enableBuiltInResolver: false })
    expect(secureDnsOptions('off', 'win32')).toEqual({ secureDnsMode: 'off', enableBuiltInResolver: false })
    expect(secureDnsOptions('off', 'darwin')).toEqual({ secureDnsMode: 'off', enableBuiltInResolver: true })
  })
})

describe('needsResolverCall', () => {
  it('skips the call at launch when off is already what the platform does', () => {
    expect(needsResolverCall('off', 'linux')).toBe(false)
    expect(needsResolverCall('off', 'win32')).toBe(false)
    expect(needsResolverCall('off', 'darwin')).toBe(true)
    expect(needsResolverCall('quad9', 'linux')).toBe(true)
  })
})

describe('applySecureDns', () => {
  it('passes the options to the resolver', () => {
    const configureHostResolver = vi.fn()
    applySecureDns({ configureHostResolver }, 'cloudflare')
    expect(configureHostResolver).toHaveBeenCalledTimes(1)
    expect(configureHostResolver.mock.calls[0]?.[0]).toMatchObject({ secureDnsMode: 'secure' })
  })

  it('logs a refusal and does not throw', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => { applySecureDns({ configureHostResolver: () => { throw new Error('before ready') } }, 'quad9') }).not.toThrow()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})

describe('the forced-off switch', () => {
  it('stands in for the default only, and only when set to off', () => {
    expect(secureDnsForcedOff({ ORIVON_SECURE_DNS: 'off' })).toBe(true)
    expect(secureDnsForcedOff({})).toBe(false)
    expect(effectiveSecureDns('quad9Fallback', true, true)).toBe('off')
    expect(effectiveSecureDns('cloudflare', false, true)).toBe('cloudflare')
    expect(effectiveSecureDns('quad9Fallback', true, false)).toBe('quad9Fallback')
  })
})

describe('reapplyResolver', () => {
  const fresh = async (): Promise<typeof import('../secure-dns.js')> => {
    vi.resetModules()
    return await import('../secure-dns.js')
  }

  it('has nothing to send while the resolver was never set', async () => {
    const dns = await fresh()
    const configureHostResolver = vi.fn()
    expect(dns.reapplyResolver({ configureHostResolver })).toBeUndefined()
    expect(configureHostResolver).not.toHaveBeenCalled()
  })

  it('sets the resolver to what it was last set to, and says what that was', async () => {
    const dns = await fresh()
    const configureHostResolver = vi.fn()
    dns.applySecureDns({ configureHostResolver }, 'cloudflare')
    dns.applySecureDns({ configureHostResolver }, 'quad9')
    const summary = dns.reapplyResolver({ configureHostResolver })
    expect(configureHostResolver).toHaveBeenCalledTimes(3)
    expect(configureHostResolver.mock.calls[2]?.[0]).toEqual(configureHostResolver.mock.calls[1]?.[0])
    expect(summary).toBe('secure, 1 server')
  })

  it('does not count a refused call as the last one set, and lets a refusal reach the caller', async () => {
    const dns = await fresh()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    dns.applySecureDns({ configureHostResolver: () => { throw new Error('before ready') } }, 'quad9')
    error.mockRestore()
    expect(dns.reapplyResolver({ configureHostResolver: vi.fn() })).toBeUndefined()
    const configureHostResolver = vi.fn()
    dns.applySecureDns({ configureHostResolver }, 'cloudflare')
    expect(() => dns.reapplyResolver({ configureHostResolver: () => { throw new Error('refused') } })).toThrow('refused')
  })
})
