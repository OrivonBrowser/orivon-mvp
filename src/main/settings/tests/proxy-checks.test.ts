import { describe, expect, it } from 'vitest'
import { isEmptyOrProxyAddress, parseProxyAddress } from '../proxy-checks.js'
import { SETTINGS, validateSetting } from '../schema.js'

describe('parseProxyAddress', () => {
  it('reads a host and a port', () => {
    expect(parseProxyAddress('127.0.0.1:9050')).toEqual({ host: '127.0.0.1', port: 9050 })
    expect(parseProxyAddress('proxy.example:1080')).toEqual({ host: 'proxy.example', port: 1080 })
    expect(parseProxyAddress('  localhost:9150 ')).toEqual({ host: 'localhost', port: 9150 })
  })

  it('reads an IPv6 literal in brackets, handing back the address without them', () => {
    expect(parseProxyAddress('[::1]:9050')).toEqual({ host: '::1', port: 9050 })
  })

  it('takes an optional socks5:// prefix', () => {
    expect(parseProxyAddress('socks5://127.0.0.1:9050')).toEqual({ host: '127.0.0.1', port: 9050 })
  })

  it('refuses anything that is not a host and a port', () => {
    for (const bad of ['', '127.0.0.1', ':9050', '127.0.0.1:', '127.0.0.1:0', '127.0.0.1:65536', '127.0.0.1:90x', 'a b:80', 'http://127.0.0.1:9050', 'socks4://h:1', '127.0.0.1:9050/x', 'user@host:1080', '::1:9050', '[::1]', '[nope]:9050', 'ho$t:80', '-.example:80']) {
      expect(parseProxyAddress(bad), bad).toBeUndefined()
    }
  })
})

describe('isEmptyOrProxyAddress', () => {
  it('takes nothing, or one address', () => {
    expect(isEmptyOrProxyAddress('')).toBe(true)
    expect(isEmptyOrProxyAddress('127.0.0.1:9050')).toBe(true)
    expect(isEmptyOrProxyAddress('nonsense')).toBe(false)
  })
})

describe('the proxy setting', () => {
  it('is empty until the person sets one, and refuses a value that is not an address', () => {
    expect(SETTINGS['network.route.proxy']).toMatchObject({ kind: 'text', default: '' })
    expect(validateSetting(SETTINGS['network.route.proxy'], '127.0.0.1:9050')).toBe('127.0.0.1:9050')
    expect(validateSetting(SETTINGS['network.route.proxy'], 'x y')).toBeUndefined()
  })
})
