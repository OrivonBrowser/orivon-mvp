import { describe, expect, it } from 'vitest'
import { describeCapabilityGrant } from '../grant-prompt-render.js'

// ADR-0068: the hardware grant's consent copy, in its own file like the other split-out kinds.

describe('describeCapabilityGrant -- devices.hid (ADR-0068)', () => {
  it('names the vendor id and says each device is asked again', () => {
    const row = describeCapabilityGrant('devices.hid', ['vendor=2c97'])
    expect(row.warning).toBe(false)
    expect(row.message).toBe('Use USB devices from vendor 0x2C97')
    expect(row.explanation).toContain('asked again before each device')
  })

  it('names each vendor once, whatever the other fields of its filters', () => {
    const row = describeCapabilityGrant('devices.hid', ['vendor=2c97,product=4011', 'vendor=2c97,usagePage=ffa0,usage=0001', 'vendor=1209'])
    expect(row.message).toBe('Use USB devices from vendors 0x2C97, 0x1209')
  })

  it('shortens a long list of vendors', () => {
    const patterns = ['0001', '0002', '0003', '0004', '0005', '0006'].map((id) => `vendor=${id}`)
    expect(describeCapabilityGrant('devices.hid', patterns).message).toBe('Use USB devices from vendors 0x0001, 0x0002, 0x0003, 0x0004 and 2 more')
  })

  it('does not read a vendor out of another field', () => {
    expect(describeCapabilityGrant('devices.hid', ['product=4011']).message).toBe('Use USB devices')
  })
})
