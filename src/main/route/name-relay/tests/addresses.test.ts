// Which addresses the relay asks a proxy to connect to, in which order, and which it never sends upstream.

import { describe, expect, it } from 'vitest'
import { isInside, keepResolverOrder, MAX_ADDRESSES, nextAddressAfterSocks, nextAddressAfterStatus, orderForProxy } from '../addresses.js'

describe('an address that means the proxy\'s own machine', () => {
  it.each([
    '127.0.0.1', '127.255.255.254', '0.0.0.0', '0.1.2.3', '169.254.169.254', '169.254.0.1',
    '::1', '::', 'fe80::1', 'febf::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.1.1', '::ffff:0.0.0.0', 'fe80::1%eth0'
  ])('is inside: %s', (address) => {
    expect(isInside(address)).toBe(true)
  })

  it.each([
    '8.8.8.8', '93.184.216.34', '10.0.0.1', '192.168.1.5', '172.16.0.9', '100.64.0.1', '126.255.255.255', '169.253.0.1', '128.0.0.1',
    '2001:db8::1', '2606:4700::1111', 'fec0::1', '::ffff:8.8.8.8', 'fd00::1', 'ff02::1'
  ])('is not: %s (a private range is a real intranet site behind a proxy)', (address) => {
    expect(isInside(address)).toBe(false)
  })

  it('does not call a string that is no address inside, and leaves it out of every list', () => {
    expect(isInside('example.com')).toBe(false)
    expect(orderForProxy(['example.com', '1.1.1.1']).usable).toEqual(['1.1.1.1'])
    expect(keepResolverOrder(['example.com', '1.1.1.1'])).toEqual(['1.1.1.1'])
  })
})

describe('toward a proxy', () => {
  it('puts IPv4 before IPv6 and keeps the order inside each', () => {
    expect(orderForProxy(['2001:db8::1', '93.184.216.1', '2001:db8::2', '93.184.216.2']).usable)
      .toEqual(['93.184.216.1', '93.184.216.2', '2001:db8::1'])
  })

  it('stops at three addresses', () => {
    expect(MAX_ADDRESSES).toBe(3)
    expect(orderForProxy(['1.1.1.1', '1.1.1.2', '1.1.1.3', '1.1.1.4', '2001:db8::1']).usable).toEqual(['1.1.1.1', '1.1.1.2', '1.1.1.3'])
    expect(orderForProxy(['1.1.1.1', '1.1.1.2', '1.1.1.3'], 1).usable).toEqual(['1.1.1.1'])
    expect(orderForProxy(['1.1.1.1'], 0).usable).toEqual([])
  })

  it('drops an inside address before counting, and says how many it dropped', () => {
    expect(orderForProxy(['127.0.0.1', '169.254.169.254', '93.184.216.1', '::1'])).toEqual({ usable: ['93.184.216.1'], inside: 3 })
    expect(orderForProxy(['127.0.0.1', '::1'])).toEqual({ usable: [], inside: 2 })
    expect(orderForProxy([])).toEqual({ usable: [], inside: 0 })
  })

  it('names an address once', () => {
    expect(orderForProxy(['1.1.1.1', '1.1.1.1', '2001:db8::1', '2001:db8::1']).usable).toEqual(['1.1.1.1', '2001:db8::1'])
  })
})

describe('for a connection the system sends outside any proxy', () => {
  it('keeps the resolver\'s order and sends an inside address as a direct connection would', () => {
    expect(keepResolverOrder(['2001:db8::1', '93.184.216.1', '127.0.0.1', '93.184.216.1'])).toEqual(['2001:db8::1', '93.184.216.1', '127.0.0.1'])
    expect(keepResolverOrder(['1.1.1.1', '1.1.1.2', '1.1.1.3', '1.1.1.4'])).toEqual(['1.1.1.1', '1.1.1.2', '1.1.1.3'])
  })
})

describe('when the next address is worth a try', () => {
  it('is after a proxy that says the address could not be reached, not after one that refuses or asks for a sign-in', () => {
    for (const status of [502, 503, 504]) expect(nextAddressAfterStatus(status)).toBe(true)
    for (const status of [400, 401, 403, 404, 407, 500, 501, 200]) expect(nextAddressAfterStatus(status)).toBe(false)
  })

  it('is after a SOCKS reply of unreachable or refused', () => {
    for (const reply of ['NetworkUnreachable', 'HostUnreachable', 'ConnectionRefused', 'Failed']) expect(nextAddressAfterSocks(reply)).toBe(true)
    for (const reply of ['Failure', 'NotAllowed', 'CommandNotSupported', 'AddressNotSupported', 'Rejected', '']) expect(nextAddressAfterSocks(reply)).toBe(false)
  })
})
