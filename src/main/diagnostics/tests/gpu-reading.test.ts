import { describe, expect, it } from 'vitest'
import { driverOf, gpuDevicesOf, gpuFeaturesOf, gpuMakerName, hex4, makerNameOf } from '../gpu-reading.js'
import type { GpuDevice } from '../gpu-reading.js'

const NOTHING: GpuDevice = { vendorId: undefined, deviceId: undefined, vendorString: '', deviceString: '', driverVendor: '', driverVersion: '', active: false }

describe('gpuFeaturesOf', () => {
  it('keeps the string statuses', () => {
    expect(gpuFeaturesOf({ webgpu: 'enabled', gpu_compositing: 'enabled', note: 3, other: null })).toEqual({ webgpu: 'enabled', gpu_compositing: 'enabled' })
  })

  it('has no features when the status is not an object', () => {
    expect(gpuFeaturesOf(undefined)).toEqual({})
    expect(gpuFeaturesOf('nope')).toEqual({})
  })
})

describe('gpuDevicesOf', () => {
  it('reads each field of a device, and leaves out what the platform did not fill', () => {
    const info = { gpuDevice: [{ vendorId: 0x8086, deviceId: 0x46a6, vendorString: 'Intel Inc.', deviceString: 'UHD', driverVendor: 'Mesa', driverVersion: '25.1.3', active: true, extra: 1 }, {}] }
    expect(gpuDevicesOf(info)).toEqual([
      { vendorId: 0x8086, deviceId: 0x46a6, vendorString: 'Intel Inc.', deviceString: 'UHD', driverVendor: 'Mesa', driverVersion: '25.1.3', active: true },
      NOTHING
    ])
  })

  it('has no list when the report could not be read or has none, rather than an empty one', () => {
    expect(gpuDevicesOf(undefined)).toBeUndefined()
    expect(gpuDevicesOf({ auxAttributes: {} })).toBeUndefined()
    expect(gpuDevicesOf({ gpuDevice: 'x' })).toBeUndefined()
    expect(gpuDevicesOf({ gpuDevice: [] })).toEqual([])
  })

  it('does not take a vendor id that is not a number', () => {
    expect(gpuDevicesOf({ gpuDevice: [{ vendorId: '0x10de' }] })?.[0]?.vendorId).toBeUndefined()
  })
})

describe('the names of a device', () => {
  it('names the makers by their PCI vendor id', () => {
    expect(gpuMakerName(0x8086)).toBe('Intel')
    expect(gpuMakerName(0x10de)).toBe('NVIDIA')
    expect(gpuMakerName(0x1002)).toBe('AMD')
    expect(gpuMakerName(0x1)).toBeUndefined()
  })

  it('puts the maker the report names before the one the id gives, and nothing when neither is known', () => {
    expect(makerNameOf({ ...NOTHING, vendorId: 0x8086, vendorString: 'Intel Corporation' })).toBe('Intel Corporation')
    expect(makerNameOf({ ...NOTHING, vendorId: 0x8086 })).toBe('Intel')
    expect(makerNameOf({ ...NOTHING, vendorId: 0xabcd })).toBe('')
    expect(makerNameOf(NOTHING)).toBe('')
  })

  it('writes the driver as its vendor and version', () => {
    expect(driverOf({ ...NOTHING, driverVendor: 'Mesa', driverVersion: '25.1.3' })).toBe('Mesa 25.1.3')
    expect(driverOf({ ...NOTHING, driverVersion: '24.2.1' })).toBe('24.2.1')
    expect(driverOf(NOTHING)).toBe('')
  })

  it('writes an id as hex of at least four digits', () => {
    expect(hex4(0x10de)).toBe('0x10de')
    expect(hex4(0x1)).toBe('0x0001')
    expect(hex4(undefined)).toBe('')
  })
})
