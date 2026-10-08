# ADR-0068: An app may declare USB HID devices, and each device is still asked

- **Status:** accepted
- **Date:** 2026-10-08
- **Type:** security
- **Decided by:** owner (apps get a hardware grant, and the browser asks again for each specific
  device); AI recommendation accepted by default (the filter shape, the canonical pattern string,
  the limit of 16, the device key)

## Decision
A new capability kind, `devices.hid`, declared in a manifest as
`capabilities.devices.hid: [{ vendorId, productId?, usagePage?, usage? }]`, at most
`LIMITS.hidFilters` (16) filters. `vendorId` is required, so there is no grant for "any HID
device". The kind opens no `orivon.*` member: an app uses the web-standard WebHID API,
`navigator.hid`, in its own page, Chromium does the device I/O, and Orivon owns the gates.

The grant bounds which devices can ever be offered to the app. It does not make one usable. The
person approves each specific device for the origin:

- **Through the chooser.** When the app calls `navigator.hid.requestDevice()`, Orivon's own chooser
  lists the devices Chromium found that a granted filter matches. Picking one is the approval.
- **Through a question in the tab.** An app that only calls `navigator.hid.getDevices()` (the
  Electron habit) never opens a chooser. When a matching, unapproved device is connected, Orivon
  asks once in the app's tab: "connect this device to this app?". Allow approves it and the app is
  told the device has appeared; "Not now" is remembered until the session ends.

An approved device is remembered for that origin until the person removes it in Settings or the
page calls `HIDDevice.forget()`. Revoking the `devices.hid` grant forgets every device of the
origin. The grant is asked on visit with the app's other kinds, and its consent row names the
vendors and says each device is asked again.

In the grant ledger a filter is one canonical string: the fields it names in the order `vendor`,
`product`, `usagePage`, `usage`, each as four lowercase hex digits (`vendor=2c97,product=4011`).
The contracts live in `src/contracts/devices.ts`, the ninth file.

Out of scope here: WebUSB and Web Serial stay denied, as do web contexts, child hosts and ordinary
websites (no manifest, so no grant).

## Context
Ledger Wallet's desktop app uses WebHID in its renderer: it lists devices with
`navigator.hid.getDevices()` and reacts to `connect` and `disconnect` events on `navigator.hid`.
Electron lets such an app answer for itself in its main process. Orivon has no main process of an
app's own, and its permission gate denies every device permission, so the app cannot see its
device. `docs/architecture/security-model.md` named `hid` as excluded and requiring an ADR to add.
The owner decided that apps get a hardware grant while the browser still asks again for each
specific device.

## Alternatives considered
- **An `orivon.hid` broker API.** Orivon would own the I/O and could shape it. Rejected: it is more
  code and a second I/O path beside the one Chromium already has, it would still need Chromium's
  WebHID underneath because Orivon's own dependencies carry no native modules (Rule 8), and every
  app that talks to a device through a library written for `navigator.hid` would need a bridge.
- **`node-hid` in a child host.** Rejected: it is a native module, which Rule 8 and `ADR-0040`
  rule out, and it would give an app raw access with no per-device question.
- **A grant that names no vendor ("any HID device").** Rejected: it hands an app every keyboard,
  security key and sensor the person plugs in. A required `vendorId` keeps a manifest honest about
  what it talks to, and gives the consent row something a person can recognise.
- **The grant alone, with no per-device question.** Rejected by the owner: a person who accepted
  "Ledger devices" has not agreed to every device of that vendor, nor to one plugged in later.
- **Ask at every connection.** Considered; the default is to remember an approved device until it
  is removed, because a wallet that asks at each plug-in is not usable. Whether that default stays
  is an open question to the owner.

## Reasoning
Parity with Electron and Chrome is what ported apps expect, and the grant system can keep it
without widening anything: a declared filter is a ceiling the web API cannot raise, and the
per-device question is the browser's own gate. Reusing `navigator.hid` means the contracts add one
declaration and no call for an app to learn.

## Consequences
- `devices.hid` is a new member of `CapabilityKind`; every exhaustive switch over it gains a case,
  and the catalogue line says `not covered` until the runtime lands.
- The runtime is a change to the permission gate, a new chooser and question, and a persisted
  per-origin device ledger. Until it lands, the loader does not accept `devices` in a manifest and
  every device permission stays denied.
- A person is asked twice for the first use of an app: once for the kind, once for the device.
- An app can enumerate nothing outside its filters; a device that matches a filter but is not
  approved is invisible to the page.
- A key that is too specific makes a person approve the same hardware again; one that is too loose
  lets a different device inherit an approval.
- Adding a field to `src/contracts/` is a change every app feels; this one is additive.

## Device key
An approval is keyed by vendor id, product id, serial number and product name. A device with no
serial number is told apart by the other three. This choice is *provisional*: a device that
re-enumerates with another product id after it unlocks or after a firmware step would be asked
once more. A real device's re-enumeration, measured, settles whether the key should drop the
product id or the name.

## Reversibility
- **Cost to reverse:** moderate. An app that declared `devices.hid` loses the kind, and the
  canonical pattern string is stored in grants, so a change to it needs a migration.
- **What would make us revisit:** the measured re-enumeration of a real device contradicting the
  device key; or the owner choosing to ask at every connection.
