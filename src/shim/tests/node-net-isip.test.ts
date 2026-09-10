import { describe, expect, it } from 'vitest'
import { isIP, isIPv4, isIPv6 } from '../node-net-isip.js'

describe('isIP', () => {
  it('recognises IPv4 literals', () => {
    expect(isIP('67.215.246.10')).toBe(4)
    expect(isIP('127.0.0.1')).toBe(4)
    expect(isIP('0.0.0.0')).toBe(4)
    expect(isIP('255.255.255.255')).toBe(4)
  })

  it('recognises IPv6 literals', () => {
    expect(isIP('::1')).toBe(6)
    expect(isIP('::')).toBe(6)
    expect(isIP('2001:db8::1')).toBe(6)
    expect(isIP('fe80::1')).toBe(6)
  })

  it('returns 0 for a hostname -- exactly the DHT bootstrap case', () => {
    expect(isIP('router.bittorrent.com')).toBe(0)
    expect(isIP('dht.transmissionbt.com')).toBe(0)
  })

  it('rejects an out-of-range octet', () => {
    expect(isIP('999.1.1.1')).toBe(0)
    expect(isIP('1.2.3.256')).toBe(0)
  })

  it('rejects garbage', () => {
    expect(isIP('')).toBe(0)
    expect(isIP('not an address')).toBe(0)
  })

  it('isIPv4/isIPv6 agree with isIP', () => {
    expect(isIPv4('10.0.0.1')).toBe(true)
    expect(isIPv6('10.0.0.1')).toBe(false)
    expect(isIPv6('::1')).toBe(true)
    expect(isIPv4('::1')).toBe(false)
  })
})
