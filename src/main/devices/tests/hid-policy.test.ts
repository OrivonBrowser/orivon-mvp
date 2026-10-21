import { describe, expect, it } from 'vitest'
import { decideHid, deviceKey, hidInfoOf, filtersFromPatterns, matchesAny, matchesFilter, parseHidPattern, type HidDeviceInfo } from '../hid-policy.js'

const NANO: HidDeviceInfo = { vendorId: 0x2c97, productId: 0x4011, serialNumber: '0001', name: 'Nano X' }

describe('deviceKey', () => {
  it('names vendor, product, serial and product name', () => {
    expect(deviceKey(NANO)).not.toBe(deviceKey({ ...NANO, serialNumber: '0002' }))
    expect(deviceKey(NANO)).not.toBe(deviceKey({ ...NANO, productId: 0x0011 }))
    expect(deviceKey(NANO)).not.toBe(deviceKey({ ...NANO, name: 'Nano S' }))
    expect(deviceKey(NANO)).toBe(deviceKey({ ...NANO }))
  })

  it('tells a device with no serial apart by the other three, and never collides on separators', () => {
    const bare = { vendorId: 1, productId: 2, name: 'a:b' }
    expect(deviceKey(bare)).toBe(deviceKey({ ...bare, serialNumber: '' }))
    expect(deviceKey({ vendorId: 1, productId: 2, serialNumber: 'a', name: 'b:c' })).not.toBe(deviceKey({ vendorId: 1, productId: 2, serialNumber: 'a:b', name: 'c' }))
  })
})

describe('parseHidPattern', () => {
  it('reads the canonical string back into a filter', () => {
    expect(parseHidPattern('vendor=2c97')).toEqual({ vendorId: 0x2c97 })
    expect(parseHidPattern('vendor=2c97,product=4011')).toEqual({ vendorId: 0x2c97, productId: 0x4011 })
    expect(parseHidPattern('vendor=2c97,usagePage=ffa0,usage=0001')).toEqual({ vendorId: 0x2c97, usagePage: 0xffa0, usage: 1 })
  })

  it.each(['', 'vendor=2C97', 'vendor=2c9', 'product=4011', 'vendor=2c97,usage=0001', 'vendor=2c97,product=4011,vendor=2c97', 'product=4011,vendor=2c97', 'vendor=2c97,extra=0001', ' vendor=2c97'])('refuses %j', (pattern) => {
    expect(parseHidPattern(pattern)).toBeNull()
  })

  it('keeps only the patterns it understands', () => {
    expect(filtersFromPatterns(['vendor=2c97', 'junk', 'vendor=1209,product=0001'])).toEqual([{ vendorId: 0x2c97 }, { vendorId: 0x1209, productId: 1 }])
  })
})

describe('matchesFilter', () => {
  it('needs every named field to be equal', () => {
    expect(matchesFilter(NANO, { vendorId: 0x2c97 })).toBe(true)
    expect(matchesFilter(NANO, { vendorId: 0x2c97, productId: 0x4011 })).toBe(true)
    expect(matchesFilter(NANO, { vendorId: 0x2c97, productId: 0x4012 })).toBe(false)
    expect(matchesFilter(NANO, { vendorId: 0x1209 })).toBe(false)
  })

  it('matches a usage page and usage against a top-level collection', () => {
    const device = { ...NANO, collections: [{ usagePage: 0xffa0, usage: 1 }, { usagePage: 1, usage: 6 }] }
    expect(matchesFilter(device, { vendorId: 0x2c97, usagePage: 0xffa0 })).toBe(true)
    expect(matchesFilter(device, { vendorId: 0x2c97, usagePage: 0xffa0, usage: 1 })).toBe(true)
    expect(matchesFilter(device, { vendorId: 0x2c97, usagePage: 0xffa0, usage: 6 })).toBe(false)
    expect(matchesFilter(device, { vendorId: 0x2c97, usagePage: 0xff00 })).toBe(false)
  })

  it('does not match a usage filter against a device that reports no collections', () => {
    expect(matchesFilter(NANO, { vendorId: 0x2c97, usagePage: 0xffa0 })).toBe(false)
    expect(matchesFilter({ ...NANO, collections: [] }, { vendorId: 0x2c97, usagePage: 0xffa0 })).toBe(false)
  })

  it('matches any of a list, and nothing for an empty one', () => {
    expect(matchesAny(NANO, [{ vendorId: 1 }, { vendorId: 0x2c97 }])).toBe(true)
    expect(matchesAny(NANO, [])).toBe(false)
  })
})

describe('decideHid', () => {
  const app = (patterns: readonly string[] | undefined) => ({ kind: 'app' as const, patterns })
  const website = (blocked: boolean) => ({ kind: 'website' as const, blocked })
  const state = { approved: false, declined: false }

  it('denies an app that holds no devices.hid grant', () => {
    expect(decideHid({ party: app(undefined), device: NANO, ...state })).toBe('deny')
    expect(decideHid({ party: app(undefined), device: NANO, approved: true, declined: false })).toBe('deny')
  })

  it('denies an app a device none of its filters matches, even an approved one', () => {
    expect(decideHid({ party: app(['vendor=1209']), device: NANO, ...state })).toBe('deny')
    expect(decideHid({ party: app(['vendor=1209']), device: NANO, approved: true, declined: false })).toBe('deny')
  })

  it('allows an app an approved device its filters match', () => {
    expect(decideHid({ party: app(['vendor=2c97']), device: NANO, approved: true, declined: false })).toBe('allow')
  })

  it('asks for a matching device that is neither approved nor declined this session', () => {
    expect(decideHid({ party: app(['vendor=2c97']), device: NANO, ...state })).toBe('ask')
  })

  it('denies a matching device the person declined this session', () => {
    expect(decideHid({ party: app(['vendor=2c97']), device: NANO, approved: false, declined: true })).toBe('deny')
  })

  it('allows a website only an approved device, and never asks', () => {
    expect(decideHid({ party: website(false), device: NANO, ...state })).toBe('deny')
    expect(decideHid({ party: website(false), device: NANO, approved: true, declined: false })).toBe('allow')
  })

  it('denies a website with the setting on Block, whatever was approved', () => {
    expect(decideHid({ party: website(true), device: NANO, approved: true, declined: false })).toBe('deny')
  })
})

describe('hidInfoOf', () => {
  it('keeps what the policy reads from an Electron device', () => {
    expect(hidInfoOf({ deviceId: '/sys/x', vendorId: 1, productId: 2, serialNumber: 's', name: 'n', collections: [{ usagePage: 3, usage: 4, type: 1 }, 'junk'] }))
      .toEqual({ vendorId: 1, productId: 2, serialNumber: 's', name: 'n', collections: [{ usagePage: 3, usage: 4 }] })
  })

  it.each([null, 'x', {}, { vendorId: 1 }, { vendorId: '1', productId: 2 }, { vendorId: 1.5, productId: 2 }])('is null for %j', (value) => {
    expect(hidInfoOf(value)).toBeNull()
  })
})
