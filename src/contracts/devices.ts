// Transcribed from docs/architecture/capability-api.md's "Devices" section.
//
// devices.ts - Hardware an app may declare (ADR-0068)
//
// Held in its own file so manifest.ts stays under the source-size limit;
// `Capabilities.devices` there is the only member that points here. There is
// no `orivon.*` call for devices: an app uses the web-standard API in its
// own page, and the grant below bounds what that API can ever offer it.

/**
 * One kind of USB HID device an app may be offered, mirroring WebHID's
 * `HIDDeviceFilter` with one difference: `vendorId` is required. There is no
 * grant for "any HID device".
 *
 * Every number is an integer from 0 to 0xFFFF. `usage` is meaningful only
 * with `usagePage`, so a filter that names `usage` alone is not valid. A
 * device matches a filter when every field the filter names equals the
 * device's own.
 *
 * As a `Grant.patterns` entry (`CapabilityKind` `'devices.hid'`) a filter is
 * one canonical string: the fields it names, in this fixed order, each as
 * four lowercase hex digits, joined by commas:
 * `vendor=2c97`, `vendor=2c97,product=4011`,
 * `vendor=2c97,usagePage=ffa0,usage=0001`. The order is
 * `vendor`, `product`, `usagePage`, `usage`.
 */
export interface HidDeviceFilter {
  readonly vendorId: number
  readonly productId?: number
  readonly usagePage?: number
  readonly usage?: number
}

/**
 * Hardware an app may ask to use (ADR-0068).
 *
 * `hid`: USB HID devices, used through the web-standard `navigator.hid` in
 * the app's own page; Orivon adds no API of its own. The filters bound which
 * devices can ever be offered to the app: a device none of them matches is
 * invisible to it, and the app cannot widen them at run time. At most
 * `LIMITS.hidFilters` filters.
 *
 * Holding the grant does not make a device usable. The person is asked for
 * EACH specific device: in a chooser when the app calls
 * `navigator.hid.requestDevice()`, or in a "connect this device?" question in
 * the app's tab when it only calls `navigator.hid.getDevices()` and a
 * matching device is plugged in. An approved device is remembered for that
 * origin until it is removed, and revoking the grant forgets them all.
 *
 * An ordinary website has no manifest and so no grant here: it is offered devices only through the chooser,
 * under the person's site settings. WebUSB and Web Serial stay unavailable; neither has a field here.
 */
export interface DevicesCapability {
  readonly hid?: readonly HidDeviceFilter[]
}
