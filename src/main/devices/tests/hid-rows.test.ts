import { describe, expect, it } from 'vitest'
import { HidApprovals } from '../hid-approvals.js'
import { createDeviceRows, labelOf } from '../hid-rows.js'

const APP = 'https://wallet.example'
const SHOP = 'https://shop.example'
const NANO = { vendorId: 0x2c97, productId: 0x4011, serialNumber: '0001', name: 'Nano X' }

describe('labelOf', () => {
  it('names the device, its USB ids and its serial number', () => {
    expect(labelOf({ key: 'k', approvedAt: 0, ...NANO })).toBe('Nano X (USB 2c97:4011), serial number 0001')
    expect(labelOf({ key: 'k', approvedAt: 0, vendorId: 0x1209, productId: 1 })).toBe('Unnamed device (USB 1209:0001)')
  })
})

describe('createDeviceRows', () => {
  function setup () {
    const approvals = new HidApprovals(null)
    approvals.approve(APP, NANO)
    approvals.approve(SHOP, NANO)
    approvals.approve(SHOP, { ...NANO, serialNumber: '0002' })
    return { approvals, rows: createDeviceRows(approvals, (origin) => origin !== APP) }
  }

  it('lists the rows of one origin, each with the key that forgets it', () => {
    const { rows } = setup()
    expect(rows.rows(SHOP).map((row) => row.label)).toEqual(['Nano X (USB 2c97:4011), serial number 0001', 'Nano X (USB 2c97:4011), serial number 0002'])
    expect(rows.rows('https://none.example')).toEqual([])
    expect(rows.siteRows(SHOP)).toHaveLength(2)
    expect(rows.siteRows(APP)).toEqual([])
  })

  it('counts devices only for the websites, never for an app', () => {
    expect(setup().rows.websites()).toEqual([{ origin: SHOP, devices: 2 }])
  })

  it('forgets one device, a whole website, and every website\'s without touching an app\'s', () => {
    const { rows, approvals } = setup()
    const first = rows.rows(SHOP)[0]
    expect(first).toBeDefined()
    expect(rows.forget(SHOP, first?.key ?? '')).toBe(true)
    expect(approvals.list(SHOP)).toHaveLength(1)
    rows.forgetSite(SHOP)
    expect(approvals.list(SHOP)).toEqual([])
    approvals.approve(SHOP, NANO)
    rows.forgetAllWebsites()
    expect(approvals.list(SHOP)).toEqual([])
    expect(approvals.list(APP)).toHaveLength(1)
  })

  it('refuses to forget a website\'s device through an app\'s name and the reverse', () => {
    const { rows, approvals } = setup()
    expect(rows.forgetSite(APP)).toBe(false)
    expect(approvals.list(APP)).toHaveLength(1)
  })
})
