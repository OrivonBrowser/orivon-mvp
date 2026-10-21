import { describe, expect, it, vi } from 'vitest'
import { createHidGate } from '../hid-gate.js'
import { deviceKey, type HidDeviceInfo } from '../hid-policy.js'

const APP = 'https://wallet.example'
const SITE = 'https://shop.example'
const NANO: HidDeviceInfo = { vendorId: 0x2c97, productId: 0x4011, serialNumber: '0001', name: 'Nano X' }
const OTHER: HidDeviceInfo = { vendorId: 0x046d, productId: 0xc52b, name: 'Receiver' }

function setup (options: { patterns?: readonly string[], approved?: string[], blocked?: boolean } = {}) {
  const approved = new Set((options.approved ?? []).map((origin) => origin))
  const keys = new Set<string>()
  const requestAsk = vi.fn()
  const gate = createHidGate({
    approvals: { has: (origin, key) => approved.has(origin) && keys.has(key) },
    isApp: (origin) => origin === APP,
    appPatterns: (origin) => origin === APP ? options.patterns : undefined,
    siteBlocked: () => options.blocked === true,
    requestAsk
  })
  return { gate, requestAsk, approve: (device: HidDeviceInfo) => { keys.add(deviceKey(device)) } }
}

describe('mayUse (the permission check)', () => {
  it('is true for an app holding the grant and false for one that does not', () => {
    expect(setup({ patterns: ['vendor=2c97'] }).gate.mayUse(APP)).toBe(true)
    expect(setup({}).gate.mayUse(APP)).toBe(false)
  })

  it('is true for a website unless its devices setting is Block', () => {
    expect(setup().gate.mayUse(SITE)).toBe(true)
    expect(setup({ blocked: true }).gate.mayUse(SITE)).toBe(false)
  })
})

describe('devicePermission', () => {
  it('asks once for a matching device of an app, answers no meanwhile, and never asks about another vendor', () => {
    const { gate, requestAsk } = setup({ patterns: ['vendor=2c97'] })
    expect(gate.devicePermission(APP, NANO)).toBe(false)
    expect(requestAsk).toHaveBeenCalledWith(APP, NANO)
    requestAsk.mockClear()
    expect(gate.devicePermission(APP, OTHER)).toBe(false)
    expect(requestAsk).not.toHaveBeenCalled()
  })

  it('allows a device the person approved, and does not ask', () => {
    const { gate, requestAsk, approve } = setup({ patterns: ['vendor=2c97'], approved: [APP] })
    approve(NANO)
    expect(gate.devicePermission(APP, NANO)).toBe(true)
    expect(requestAsk).not.toHaveBeenCalled()
  })

  it('does not allow an approved device once the grant no longer matches it', () => {
    const { gate, approve } = setup({ patterns: ['vendor=1209'], approved: [APP] })
    approve(NANO)
    expect(gate.devicePermission(APP, NANO)).toBe(false)
  })

  it('stops asking about a device the person declined, until the session ends', () => {
    const { gate, requestAsk } = setup({ patterns: ['vendor=2c97'] })
    gate.decline(APP, NANO)
    expect(gate.devicePermission(APP, NANO)).toBe(false)
    expect(requestAsk).not.toHaveBeenCalled()
    expect(gate.devicePermission(APP, { ...NANO, serialNumber: '0002' })).toBe(false)
    expect(requestAsk).toHaveBeenCalledOnce()
  })

  it('never asks about a device for a website, and allows only one it approved', () => {
    const { gate, requestAsk, approve } = setup({ approved: [SITE] })
    expect(gate.devicePermission(SITE, NANO)).toBe(false)
    expect(requestAsk).not.toHaveBeenCalled()
    approve(NANO)
    expect(gate.devicePermission(SITE, NANO)).toBe(true)
    expect(gate.devicePermission(APP, NANO)).toBe(false)
  })
})

describe('chooserDevices', () => {
  it('offers an app only the devices its grant matches', () => {
    const { gate } = setup({ patterns: ['vendor=2c97'] })
    expect(gate.chooserDevices(APP, [NANO, OTHER])).toEqual([NANO])
  })

  it('offers a website every device Chromium listed, and nothing when it is blocked', () => {
    expect(setup().gate.chooserDevices(SITE, [NANO, OTHER])).toEqual([NANO, OTHER])
    expect(setup({ blocked: true }).gate.chooserDevices(SITE, [NANO])).toBeNull()
  })

  it('offers an app without the grant no chooser at all', () => {
    expect(setup({}).gate.chooserDevices(APP, [NANO])).toBeNull()
  })

  it('offers an empty list for an app whose devices are not connected', () => {
    expect(setup({ patterns: ['vendor=2c97'] }).gate.chooserDevices(APP, [OTHER])).toEqual([])
  })
})
