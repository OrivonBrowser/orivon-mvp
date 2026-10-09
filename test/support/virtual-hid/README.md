# `test/support/virtual-hid/` — a virtual USB HID device for a test

**What lives here.** `startVirtualHidDevice()`, which puts a real USB HID device on this Linux machine for the length
of a test, so Chromium's own HID stack (WebHID, `select-hid-device`, `getDevices()`) sees it. Chromium enumerates
hidraw nodes through udev, so nothing short of a kernel device works.

**What it depends on.** Linux with the `uhid` module (`/dev/uhid`), and Docker. The root-only part runs in a
short-lived container (`node:24-slim`, or `ORIVON_VIRTUAL_HID_IMAGE`); nothing stays installed and the container
is removed when the test ends.

**What it must never import.** Anything under `src/`. It is a harness; the code under test never sees it.

## Use

```ts
import { startVirtualHidDevice, virtualHidAvailable } from '../support/virtual-hid/index.ts'

const why = await virtualHidAvailable() // true, or the reason it cannot run here
const device = await startVirtualHidDevice({ vendorId: 0x1209, productId: 0x0001, name: 'Test Key', serial: 'SN-1' })
// device.node is 'hidrawN'; /dev/hidrawN is mode 0666. WebHID sees productName 'Test Key', serialNumber 'SN-1'.
await device.stop() // always, in a finally
```

A spec that needs the device skips with `virtualHidAvailable()`'s reason in the test name, never silently;
`ORIVON_REQUIRE_VIRTUAL_HID=1` turns that skip into a failure. Use a generic test id (pid.codes `0x1209`), never a
real product's.

Options: `descriptor` (default: vendor page 0xFFA0, one 64-byte input and one 64-byte output report, no report id),
`reportIds` (true when the descriptor numbers its reports), `responder`, `env`, `image`, `readyTimeoutMs`,
`lifetimeS`.

## Responders

The device answers each report the host writes. The default is `echo` (input = output). `responder` is the path of
a `.ts` module whose default export is `(report: Uint8Array, send: (report: Uint8Array) => void, device: { replug:
() => void }) => void | Promise<void>`; it may itself be a promise. `report` has the leading report-id byte of an
unnumbered report removed. `device.replug()` unplugs the device 100 ms after the call, so the host reads what was
just sent, and plugs it back in 500 ms later with the same ids, as a USB device does when it re-enumerates; the
host sees `disconnect` and `connect`, and `device.node` follows the new node. Reports are handed over one at a time, in arrival order, even when an earlier answer is still pending. The
module's directory is mounted read-only at `/responder` and `env` is passed as `-e K=V`. The container shares the
host network (`--network host`), so a responder can reach an emulator on `127.0.0.1`.

## Run the self-test

```
HEAVY_WAIT_S=3600 ~/.claude/orivon-fleet/bin/heavy npx vitest run --config test/vitest.e2e.config.ts test/support/virtual-hid
```

`tests/uhid.test.ts` and `tests/responder.test.ts` need nothing. `tests/e2e-virtual-hid-device.test.ts` creates a
device, checks the node is `0666`, writes a 65-byte report and reads the 64-byte echo, and checks the node is gone
after `stop()`.

## Design notes

- The container program (`container-main.ts`) is plain Node run by type stripping, so the files it imports use no
  enums, namespaces or parameter properties. `uhid.ts` and `responder.ts` hold everything that can be tested
  without a kernel.
- The device cannot outlive its test: the container destroys it on SIGTERM, after `lifetimeS` (600 s), and the
  kernel destroys it if the container dies, since closing `/dev/uhid` ends the device.
- An unnumbered output report reaches uhid with a leading `0x00`; the responder never sees it.
- The node is found by its HID device instance (`0003:1209:0001.0007`, the target of `/sys/class/hidraw/<node>/device`),
  taking the one that did not exist before the create. The kernel can reuse a `hidrawN` number, and two devices
  with the same ids share a `HID_ID`; only the instance tells a new device from a twin or from its own earlier plug.
