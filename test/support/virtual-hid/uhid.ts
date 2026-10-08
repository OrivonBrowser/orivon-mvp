// The Linux uhid wire format and the pure parsing around it. A `struct uhid_event` is packed,
// little-endian and always 4376 bytes: a u32 type followed by a 4372-byte union.
export const UHID_EVENT_SIZE = 4376
const DATA_SIZE = 4096

export const UHID_DESTROY = 1
export const UHID_START = 2
export const UHID_OPEN = 4
export const UHID_CLOSE = 5
export const UHID_OUTPUT = 6
export const UHID_CREATE2 = 11
export const UHID_INPUT2 = 12

/** The line the in-container program prints once the node is usable, followed by JSON `{node}`. */
export const READY_PREFIX = 'ORIVON_VIRTUAL_HID_READY '

const BUS_USB = 0x03

/** Vendor page 0xFFA0: one 64-byte input and one 64-byte output report, no report id. */
export const DEFAULT_DESCRIPTOR = Uint8Array.from([
  0x06, 0xa0, 0xff, 0x09, 0x01, 0xa1, 0x01,
  0x09, 0x03, 0x15, 0x00, 0x26, 0xff, 0x00, 0x75, 0x08, 0x95, 0x40, 0x81, 0x08,
  0x09, 0x04, 0x15, 0x00, 0x26, 0xff, 0x00, 0x75, 0x08, 0x95, 0x40, 0x91, 0x08,
  0xc0
])

export interface VirtualHidDeviceOptions {
  readonly vendorId: number
  readonly productId: number
  /** WebHID `productName`. */
  readonly name: string
  /** WebHID `serialNumber`. */
  readonly serial: string
  /** A report descriptor as lowercase hex; the default is {@link DEFAULT_DESCRIPTOR}. */
  readonly descriptorHex?: string
  /** True when the descriptor numbers its reports, so the first byte of a report is its id. */
  readonly reportIds?: boolean
}

function writeString (view: Uint8Array, offset: number, text: string, capacity: number): void {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length >= capacity) throw new RangeError(`"${text}" does not fit in ${capacity - 1} bytes`)
  view.set(bytes, offset)
}

export function packCreate2 (options: VirtualHidDeviceOptions): Uint8Array {
  const descriptor = options.descriptorHex === undefined ? DEFAULT_DESCRIPTOR : hexToBytes(options.descriptorHex)
  if (descriptor.length === 0 || descriptor.length > DATA_SIZE) throw new RangeError('report descriptor must be 1..4096 bytes')
  const out = new Uint8Array(UHID_EVENT_SIZE)
  const view = new DataView(out.buffer)
  view.setUint32(0, UHID_CREATE2, true)
  writeString(out, 4, options.name, 128)
  writeString(out, 4 + 128, 'orivon-virtual-hid', 64)
  writeString(out, 4 + 128 + 64, options.serial, 64)
  const fields = 4 + 128 + 64 + 64
  view.setUint16(fields, descriptor.length, true)
  view.setUint16(fields + 2, BUS_USB, true)
  view.setUint32(fields + 4, options.vendorId, true)
  view.setUint32(fields + 8, options.productId, true)
  view.setUint32(fields + 12, 0x0100, true)
  view.setUint32(fields + 16, 0, true)
  out.set(descriptor, fields + 20)
  return out
}

export function packInput2 (report: Uint8Array): Uint8Array {
  if (report.length > DATA_SIZE) throw new RangeError('input report over 4096 bytes')
  const out = new Uint8Array(UHID_EVENT_SIZE)
  const view = new DataView(out.buffer)
  view.setUint32(0, UHID_INPUT2, true)
  view.setUint16(4, report.length, true)
  out.set(report, 6)
  return out
}

export function packDestroy (): Uint8Array {
  const out = new Uint8Array(UHID_EVENT_SIZE)
  new DataView(out.buffer).setUint32(0, UHID_DESTROY, true)
  return out
}

export type UhidEvent =
  | { readonly type: 'output', readonly data: Uint8Array, readonly reportType: number }
  | { readonly type: 'other', readonly code: number }

export function parseEvent (event: Uint8Array): UhidEvent {
  const view = new DataView(event.buffer, event.byteOffset, event.byteLength)
  const code = view.getUint32(0, true)
  if (code !== UHID_OUTPUT) return { type: 'other', code }
  const size = Math.min(view.getUint16(4 + DATA_SIZE, true), DATA_SIZE)
  return { type: 'output', data: event.slice(4, 4 + size), reportType: view.getUint8(4 + DATA_SIZE + 2) }
}

/** An unnumbered output report reaches uhid with a leading 0x00 that the device never sees. */
export function stripReportId (data: Uint8Array, reportIds: boolean): Uint8Array {
  return !reportIds && data.length > 0 && data[0] === 0 ? data.slice(1) : data
}

export function hidId (vendorId: number, productId: number): string {
  const hex = (n: number): string => n.toString(16).toUpperCase().padStart(8, '0')
  return `0003:${hex(vendorId)}:${hex(productId)}`
}

/** True when a sysfs uevent file describes the USB device with these ids. */
export function ueventMatches (uevent: string, vendorId: number, productId: number): boolean {
  return uevent.split('\n').includes(`HID_ID=${hidId(vendorId, productId)}`)
}

/** `hidraw3` from `/sys/class/hidraw/hidraw3/device/uevent`. */
export function hidrawNameOf (ueventPath: string): string | undefined {
  return /\/hidraw\/(hidraw\d+)\//.exec(ueventPath)?.[1]
}

export function hexToBytes (hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '')
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new RangeError('not a hex string')
  return Uint8Array.from(clean.match(/../g) ?? [], (pair) => parseInt(pair, 16))
}

export function bytesToHex (bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
