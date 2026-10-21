// capabilities.devices (ADR-0068): a vendor id is required, every number fits sixteen bits, `usage` needs
// `usagePage`, and the list is neither empty nor longer than LIMITS.hidFilters.

import { describe, expect, it } from 'vitest'
import { LIMITS } from '../../../contracts/index.js'
import { patternSetFromCapabilities } from '../../../broker/policy/manifest-patterns.js'
import { parseManifest } from '../manifest.js'

const manifestWith = (devices: unknown): string => JSON.stringify({
  orivonApiVersion: 0, id: 'app.test', name: 'Test', version: '1.0.0', entry: 'index.html', capabilities: { devices }
})

function rejection (devices: unknown): string {
  const result = parseManifest(manifestWith(devices))
  if (result.ok) throw new Error('expected the manifest to be rejected, and it parsed instead')
  return result.reason
}

describe('capabilities.devices', () => {
  it('accepts filters and returns them unchanged', () => {
    const hid = [{ vendorId: 0x2c97 }, { vendorId: 0x1209, productId: 1 }, { vendorId: 0x1209, usagePage: 0xffa0, usage: 1 }]
    const result = parseManifest(manifestWith({ hid }))
    if (!result.ok) throw new Error(result.reason)
    expect(result.manifest.capabilities.devices).toEqual({ hid })
  })

  it('turns the filters into the ledger\'s canonical strings', () => {
    const result = parseManifest(manifestWith({ hid: [{ vendorId: 0x2c97 }, { vendorId: 0x2c97, productId: 0x4011 }, { vendorId: 0x1209, usagePage: 0xffa0, usage: 1 }] }))
    if (!result.ok) throw new Error(result.reason)
    expect(patternSetFromCapabilities(result.manifest.capabilities)['devices.hid']).toEqual([
      'vendor=2c97', 'vendor=2c97,product=4011', 'vendor=1209,usagePage=ffa0,usage=0001'
    ])
  })

  it.each([
    ['no filter at all', { hid: [] }],
    ['an empty object', {}],
    ['no vendor', { hid: [{ productId: 1 }] }],
    ['a vendor that is not a number', { hid: [{ vendorId: '2c97' }] }],
    ['a vendor over sixteen bits', { hid: [{ vendorId: 0x10000 }] }],
    ['a negative product', { hid: [{ vendorId: 1, productId: -1 }] }],
    ['a fractional usage page', { hid: [{ vendorId: 1, usagePage: 1.5 }] }],
    ['a usage without a usage page', { hid: [{ vendorId: 1, usage: 1 }] }],
    ['an unknown filter field', { hid: [{ vendorId: 1, serial: 'x' }] }],
    ['an unknown devices field', { hid: [{ vendorId: 1 }], usb: [] }],
    ['a filter that is not an object', { hid: [5] }],
    ['hid that is not an array', { hid: { vendorId: 1 } }],
    ['a repeated filter', { hid: [{ vendorId: 1 }, { vendorId: 1 }] }],
    ['one filter too many', { hid: Array.from({ length: LIMITS.hidFilters + 1 }, (_, vendorId) => ({ vendorId })) }]
  ])('rejects %s', (_name, devices) => {
    expect(rejection(devices)).toMatch(/devices/)
  })

  it('accepts exactly LIMITS.hidFilters filters', () => {
    const hid = Array.from({ length: LIMITS.hidFilters }, (_, vendorId) => ({ vendorId }))
    expect(parseManifest(manifestWith({ hid })).ok).toBe(true)
  })
})
