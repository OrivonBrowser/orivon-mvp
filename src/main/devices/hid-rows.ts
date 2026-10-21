// The approved devices as Settings shows them: one line per device with the key that forgets it, for an app's card in
// Apps and for a site under Sites. Pure over the approvals it is handed.
import type { ApprovedDevice, HidApprovals } from './hid-approvals.js'

export interface DeviceRow {
  readonly key: string
  readonly label: string
}

const hex = (value: number): string => value.toString(16).padStart(4, '0')

export function labelOf (device: ApprovedDevice): string {
  const name = device.name === undefined || device.name === '' ? 'Unnamed device' : device.name
  const serial = device.serialNumber === undefined ? '' : `, serial number ${device.serialNumber}`
  return `${name} (USB ${hex(device.vendorId)}:${hex(device.productId)})${serial}`
}

export interface DeviceRows {
  rows: (origin: string) => DeviceRow[]
  /** `rows`, but empty for an app: a website's list under Sites never shows an app's devices. */
  siteRows: (origin: string) => DeviceRow[]
  forget: (origin: string, key: string) => boolean
  /** Every website with an approved device, with how many. An app is not one. */
  websites: () => Array<{ readonly origin: string, readonly devices: number }>
  /** Forgets all of a website's devices; false for an app, whose devices go with its grant or one at a time. */
  forgetSite: (origin: string) => boolean
  forgetAllWebsites: () => void
}

export function createDeviceRows (approvals: Pick<HidApprovals, 'list' | 'origins' | 'forget' | 'forgetOrigin'>, isWebsite: (origin: string) => boolean): DeviceRows {
  const rows = (origin: string): DeviceRow[] => approvals.list(origin).map((device) => ({ key: device.key, label: labelOf(device) }))
  return {
    rows,
    siteRows: (origin) => isWebsite(origin) ? rows(origin) : [],
    forget: (origin, key) => approvals.forget(origin, key),
    websites: () => approvals.origins().filter(isWebsite).map((origin) => ({ origin, devices: approvals.list(origin).length })),
    forgetSite: (origin) => isWebsite(origin) && approvals.forgetOrigin(origin),
    forgetAllWebsites: () => { for (const origin of approvals.origins()) if (isWebsite(origin)) approvals.forgetOrigin(origin) }
  }
}
