// What the HID chooser sheet shows and how a row maps back to a device. Pure: the sheet itself is `askChooser`.
import type { ChooserSpec } from '../auth/chooser-store.js'
import type { HidDeviceInfo } from './hid-policy.js'

const hex = (value: number): string => value.toString(16).padStart(4, '0')

/** The row ids are the places in the list, so the device a pick names is always one the sheet offered. */
export function chooserSpecFor (origin: string, devices: readonly HidDeviceInfo[]): ChooserSpec {
  return {
    title: 'Connect a device',
    origin,
    line: 'This page wants to connect to a USB device. Only the one you pick can be used.',
    preselect: false,
    confirm: 'Connect',
    empty: 'No compatible devices are connected.',
    items: devices.map((device, index) => ({
      id: String(index),
      title: device.name === undefined || device.name === '' ? 'Unnamed device' : device.name,
      sub: `USB ${hex(device.vendorId)}:${hex(device.productId)}`,
      ...(device.serialNumber === undefined || device.serialNumber === '' ? {} : { meta: `Serial number ${device.serialNumber}` })
    }))
  }
}

export function pickedDevice (devices: readonly HidDeviceInfo[], choice: string | null): HidDeviceInfo | undefined {
  if (choice === null || !/^\d{1,4}$/.test(choice)) return undefined
  return devices[Number(choice)]
}
