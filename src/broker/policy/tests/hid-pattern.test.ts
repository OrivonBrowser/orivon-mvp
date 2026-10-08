import { describe, expect, it } from 'vitest'
import { decideGrantRequest } from '../request-grant.js'
import { covers } from '../update.js'
import { hidFilterToPattern, parseHidPattern } from '../hid-pattern.js'

describe('hid patterns', () => {
  it('writes the fields it names in the fixed order, four lowercase hex digits each', () => {
    expect(hidFilterToPattern({ vendorId: 0x2c97 })).toBe('vendor=2c97')
    expect(hidFilterToPattern({ vendorId: 0x2c97, productId: 0x4011 })).toBe('vendor=2c97,product=4011')
    expect(hidFilterToPattern({ vendorId: 0xabc, usagePage: 0xffa0, usage: 1 })).toBe('vendor=0abc,usagePage=ffa0,usage=0001')
  })

  it('reads back what it writes', () => {
    for (const filter of [{ vendorId: 1 }, { vendorId: 2, productId: 3 }, { vendorId: 0xffff, productId: 0, usagePage: 0xff00, usage: 0xffff }]) {
      expect(parseHidPattern(hidFilterToPattern(filter))).toEqual(filter)
    }
  })

  it('covers only an equal pattern, so a changed filter asks again', () => {
    expect(covers('vendor=2c97', 'vendor=2c97')).toBe(true)
    expect(covers('vendor=2c97', 'vendor=2c97,product=4011')).toBe(false)
    expect(covers('vendor=2c97', 'vendor=1209')).toBe(false)
    expect(covers('*:*', 'vendor=2c97')).toBe(false)
    expect(covers('vendor=2c97', '*:*')).toBe(false)
  })
})

describe('decideGrantRequest for devices.hid', () => {
  const manifest = { orivonApiVersion: 0, id: 'a.b', name: 'A', version: '1.0.0', entry: '/', capabilities: { devices: { hid: [{ vendorId: 0x2c97 }] } } } as const

  it('allows the declared filter and refuses any other', () => {
    expect(decideGrantRequest(manifest, 'devices.hid', ['vendor=2c97']).allowed).toBe(true)
    expect(decideGrantRequest(manifest, 'devices.hid', ['vendor=1209']).allowed).toBe(false)
    expect(decideGrantRequest(manifest, 'devices.hid', ['vendor=2c97,product=4011']).allowed).toBe(false)
  })
})
