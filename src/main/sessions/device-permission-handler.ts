// The one answer a session gives for a device permission (USB HID, USB, serial). Sessions must not import the device
// feature, so it binds its handler here; until then, and for every device kind it does not take, the answer is no.
import type { DevicePermissionHandlerHandlerDetails } from 'electron'

export type DevicePermissionHandler = (details: DevicePermissionHandlerHandlerDetails) => boolean

let bound: DevicePermissionHandler | undefined

/** Binds the handler that may allow a HID device, or unbinds with `undefined`. */
export function bindDevicePermissionHandler (handler: DevicePermissionHandler | undefined): void {
  bound = handler
}

/** What `denyByDefault` installs on every session. A handler that throws answers no. */
export function handleDevicePermission (details: DevicePermissionHandlerHandlerDetails): boolean {
  if (bound === undefined || details.deviceType !== 'hid') return false
  try {
    return bound(details)
  } catch (error) {
    console.error('[device-permission] the handler failed:', error)
    return false
  }
}
