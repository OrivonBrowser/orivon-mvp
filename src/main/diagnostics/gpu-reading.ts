// What Chromium reports about the graphics setup, parsed in one place for everything that reads it: the About
// tables, a report's diagnostics and webgpu-state.ts. A platform fills only some fields of a device, so each field is
// optional here and the callers never re-check the shape. Durable: pure.

export interface GpuDevice {
  /** The PCI vendor id, or undefined when the report names none. */
  readonly vendorId: number | undefined
  readonly deviceId: number | undefined
  readonly vendorString: string
  readonly deviceString: string
  /** `driverVendor`, such as `Mesa` or `NVIDIA`; empty when the platform does not report one. */
  readonly driverVendor: string
  readonly driverVersion: string
  readonly active: boolean
}

function record (value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

const textOf = (value: unknown): string => typeof value === 'string' ? value : ''

const numberOf = (value: unknown): number | undefined => typeof value === 'number' ? value : undefined

/** The feature statuses of `app.getGPUFeatureStatus()`: the string entries, keyed by Chromium's own names. */
export function gpuFeaturesOf (status: unknown): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(record(status)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

/** The devices in `getGPUInfo('basic')`. Undefined unless the report has a device list: a report that could not be
 * read, or that has none to give, must not read as a computer without a graphics card. */
export function gpuDevicesOf (info: unknown): readonly GpuDevice[] | undefined {
  const list = record(info)['gpuDevice']
  if (!Array.isArray(list)) return undefined
  return list.map((entry) => {
    const device = record(entry)
    return {
      vendorId: numberOf(device['vendorId']),
      deviceId: numberOf(device['deviceId']),
      vendorString: textOf(device['vendorString']),
      deviceString: textOf(device['deviceString']),
      driverVendor: textOf(device['driverVendor']),
      driverVersion: textOf(device['driverVersion']),
      active: device['active'] === true
    }
  })
}

const MAKERS: Readonly<Record<number, string>> = {
  0x8086: 'Intel',
  0x10de: 'NVIDIA',
  0x1002: 'AMD',
  0x106b: 'Apple',
  0x1414: 'Microsoft',
  0x1ae0: 'Google (SwiftShader)',
  0x5143: 'Qualcomm',
  0x13b5: 'Arm'
}

/** The maker behind a PCI vendor id, or undefined for one Orivon does not name. */
export function gpuMakerName (vendorId: number): string | undefined {
  return MAKERS[vendorId]
}

/** What a device's maker is called: the name the report gives, else the one Orivon knows the id by, else ''. */
export function makerNameOf (device: GpuDevice): string {
  if (device.vendorString !== '') return device.vendorString
  return device.vendorId === undefined ? '' : gpuMakerName(device.vendorId) ?? ''
}

/** The driver as the device table writes it: its vendor and version, or '' when the report names neither. */
export function driverOf (device: GpuDevice): string {
  return [device.driverVendor, device.driverVersion].filter((part) => part !== '').join(' ')
}

/** An id as four hex digits at least, `0x10de`; '' for none. */
export function hex4 (value: number | undefined): string {
  return value === undefined ? '' : `0x${value.toString(16).padStart(4, '0')}`
}
