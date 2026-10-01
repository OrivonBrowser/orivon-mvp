import { describe, expect, it, vi } from 'vitest'
import { applySecureDns, needsResolverCall, secureDnsOptions } from '../secure-dns.js'

describe('secureDnsOptions', () => {
  it('turns the provider choices into secure mode with that provider\'s template', () => {
    expect(secureDnsOptions('cloudflare', 'linux')).toEqual({ secureDnsMode: 'secure', secureDnsServers: ['https://cloudflare-dns.com/dns-query'], enableBuiltInResolver: true })
    expect(secureDnsOptions('quad9', 'win32')).toEqual({ secureDnsMode: 'secure', secureDnsServers: ['https://dns.quad9.net/dns-query'], enableBuiltInResolver: true })
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
