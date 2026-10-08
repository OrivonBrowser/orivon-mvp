import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DESCRIPTOR, UHID_CREATE2, UHID_EVENT_SIZE, UHID_INPUT2, UHID_OUTPUT, bytesToHex, hexToBytes, hidId,
  hidrawNameOf, packCreate2, packDestroy, packInput2, parseEvent, stripReportId, ueventMatches
} from '../uhid.ts'

const device = { vendorId: 0x1209, productId: 0x0001, name: 'Test Key', serial: 'SN-1' }

describe('uhid packing', () => {
  it('lays a create event out as the kernel struct, little-endian and 4376 bytes', () => {
    const bytes = packCreate2(device)
    const view = new DataView(bytes.buffer)
    expect(bytes.length).toBe(UHID_EVENT_SIZE)
    expect(view.getUint32(0, true)).toBe(UHID_CREATE2)
    expect(new TextDecoder().decode(bytes.slice(4, 12))).toBe('Test Key')
    expect(new TextDecoder().decode(bytes.slice(4 + 128 + 64, 4 + 128 + 64 + 4))).toBe('SN-1')
    const fields = 4 + 128 + 64 + 64
    expect(view.getUint16(fields, true)).toBe(DEFAULT_DESCRIPTOR.length)
    expect(view.getUint16(fields + 2, true)).toBe(0x03)
    expect(view.getUint32(fields + 4, true)).toBe(0x1209)
    expect(view.getUint32(fields + 8, true)).toBe(0x0001)
    expect(bytes.slice(fields + 20, fields + 20 + DEFAULT_DESCRIPTOR.length)).toEqual(DEFAULT_DESCRIPTOR)
  })

  it('takes a descriptor given as hex and refuses a name that does not fit', () => {
    const bytes = packCreate2({ ...device, descriptorHex: '06a0ff 09 01 a1 01 c0' })
    expect(new DataView(bytes.buffer).getUint16(4 + 128 + 64 + 64, true)).toBe(8)
    expect(() => packCreate2({ ...device, name: 'x'.repeat(128) })).toThrow(RangeError)
  })

  it('packs an input report with its size ahead of the data', () => {
    const bytes = packInput2(Uint8Array.from([1, 2, 3]))
    const view = new DataView(bytes.buffer)
    expect(bytes.length).toBe(UHID_EVENT_SIZE)
    expect(view.getUint32(0, true)).toBe(UHID_INPUT2)
    expect(view.getUint16(4, true)).toBe(3)
    expect([...bytes.slice(6, 9)]).toEqual([1, 2, 3])
  })

  it('packs a destroy event as a bare type', () => {
    expect(new DataView(packDestroy().buffer).getUint32(0, true)).toBe(1)
  })
})

describe('uhid events', () => {
  it('reads an output event down to the report the host wrote', () => {
    const event = new Uint8Array(UHID_EVENT_SIZE)
    const view = new DataView(event.buffer)
    view.setUint32(0, UHID_OUTPUT, true)
    event.set([0, 9, 8], 4)
    view.setUint16(4 + 4096, 3, true)
    view.setUint8(4 + 4096 + 2, 1)
    expect(parseEvent(event)).toEqual({ type: 'output', data: Uint8Array.from([0, 9, 8]), reportType: 1 })
  })

  it('reports any other event by its code', () => {
    const event = new Uint8Array(UHID_EVENT_SIZE)
    new DataView(event.buffer).setUint32(0, 4, true)
    expect(parseEvent(event)).toEqual({ type: 'other', code: 4 })
  })

  it('drops the leading zero of an unnumbered report and keeps a numbered one whole', () => {
    expect([...stripReportId(Uint8Array.from([0, 7, 7]), false)]).toEqual([7, 7])
    expect([...stripReportId(Uint8Array.from([5, 7, 7]), false)]).toEqual([5, 7, 7])
    expect([...stripReportId(Uint8Array.from([0, 7, 7]), true)]).toEqual([0, 7, 7])
  })
})

describe('hidraw lookup', () => {
  it('writes the id as eight uppercase hex digits per half', () => {
    expect(hidId(0x1209, 0x0a1f)).toBe('0003:00001209:00000A1F')
  })

  it('matches a uevent by its HID_ID line only', () => {
    const uevent = 'DRIVER=hid-generic\nHID_ID=0003:00001209:00000001\nHID_NAME=Test Key\n'
    expect(ueventMatches(uevent, 0x1209, 1)).toBe(true)
    expect(ueventMatches(uevent, 0x1209, 2)).toBe(false)
    expect(ueventMatches('HID_NAME=HID_ID=0003:00001209:00000001', 0x1209, 1)).toBe(false)
  })

  it('names the node from the sysfs path', () => {
    expect(hidrawNameOf('/sys/class/hidraw/hidraw12/device/uevent')).toBe('hidraw12')
    expect(hidrawNameOf('/sys/class/input/input1/uevent')).toBeUndefined()
  })
})

describe('hex', () => {
  it('round-trips and rejects bad input', () => {
    expect(bytesToHex(hexToBytes('00 ff 1A'))).toBe('00ff1a')
    expect(() => hexToBytes('abc')).toThrow(RangeError)
    expect(() => hexToBytes('zz')).toThrow(RangeError)
  })
})
