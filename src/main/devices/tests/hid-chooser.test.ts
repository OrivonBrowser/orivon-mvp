import { describe, expect, it } from 'vitest'
import { chooserSpecFor, pickedDevice } from '../hid-chooser.js'
import type { HidDeviceInfo } from '../hid-policy.js'

const NANO: HidDeviceInfo = { vendorId: 0x2c97, productId: 0x4011, serialNumber: '0001', name: 'Nano X' }
const BARE: HidDeviceInfo = { vendorId: 0x1209, productId: 0x0001 }

describe('chooserSpecFor', () => {
  it('has one row per device: its name, its USB ids and its serial number', () => {
    const spec = chooserSpecFor('https://wallet.example', [NANO, BARE])
    expect(spec.items).toEqual([
      { id: '0', title: 'Nano X', sub: 'USB 2c97:4011', meta: 'Serial number 0001' },
      { id: '1', title: 'Unnamed device', sub: 'USB 1209:0001' }
    ])
    expect(spec).toMatchObject({ origin: 'https://wallet.example', preselect: false })
    expect(spec.empty).toMatch(/no .*device/i)
  })

  it('is an empty chooser, with something to say, when no device fits', () => {
    expect(chooserSpecFor('https://wallet.example', []).items).toEqual([])
  })
})

describe('pickedDevice', () => {
  it('maps a row id back to the device, and refuses anything it did not offer', () => {
    const devices = [NANO, BARE]
    expect(pickedDevice(devices, '1')).toBe(BARE)
    expect(pickedDevice(devices, null)).toBeUndefined()
    expect(pickedDevice(devices, '2')).toBeUndefined()
    expect(pickedDevice(devices, '-1')).toBeUndefined()
    expect(pickedDevice(devices, '1e0')).toBeUndefined()
  })
})
