# `src/main/devices/`: WebHID for an app and for a website

**What lives here.** The runtime of `devices.hid`
([ADR-0068](../../../docs/decisions/ADR-0068-usb-hid-devices-for-apps.md)): an app uses `navigator.hid` in its own page,
Chromium does the device I/O, and these files are the gates in front of it.

| File | Job |
|---|---|
| `hid-policy.ts` | Pure: the device key an approval is stored under, filter matching, and the one decision `allow`, `ask` or `deny` |
| `hid-gate.ts` | Pure over its dependencies: the permission check, the device permission handler's answer, what the chooser lists, and "Not now" for the session |
| `hid-approvals.ts` | The devices the person approved, per origin, in `hid-devices.json` under the profile; loopback and plain-http origins stay in memory |
| `hid-asker.ts` | Pure over its dependencies: "Connect this device to this app?", one open question per origin and device |
| `hid-select.ts`, `hid-chooser.ts` | `navigator.hid.requestDevice()`: Orivon's chooser in place of Electron's pick of the first device, and the pick as the approval |
| `hid-site-asker.ts` | The `hid` permission check, joined to the per-site asker registry |
| `hid-grant-watch.ts` | Revoking the app's grant forgets its devices |
| `hid-rows.ts` | The approved devices as Settings shows them, under an app's card and under a site |
| `install-choosers.ts` | The installer that wires all of the above to the sessions and the tabs |

**What it depends on.** `electron` (the installer only), [`../shell/`](../shell/) (`ShellInstaller`, `ShellServices`, `askQuestion`),
[`../auth/`](../auth/) (`askChooser`), [`../sessions/`](../sessions/) (`site-asks.ts`, `device-permission-handler.ts`),
[`../site-settings/`](../site-settings/) (`app-origin.ts`), [`../../broker/policy/`](../../broker/policy/) (the filter grammar).

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts) or [`../shell/tab-view.ts`](../shell/tab-view.ts).

**Owner stream.** `shell`.

**Electron dependence.** The installer and the handlers it registers are tied to Electron; every other file here imports no `electron` at runtime and is unit tested with fakes.

## Design notes

**The device permission handler is consulted for every HID device on the machine, not only the ones an app asks about.**
Chromium calls it for each device whenever a page lists devices or a device connects, so `hid-gate.ts` answers from the
grant's filters first and starts a question only for a device a filter matches. A device outside the grant is never
asked about, and a website is never asked at all: only the chooser asks a website.

**A chooser pick counts only if the handler says yes for that device**, so `hid-select.ts` records the approval before it
tells Chromium which device was picked.

**The page is told a device appeared with an event built in its own world** (`../../preload/hid-announce.ts`): Electron 44
builds a `HIDConnectionEvent` whose `device` is null, so the event gets an own `device` property, taken from the page's
`getDevices()`.

**An approval is dropped when the grant is.** The broker reports only that an origin's grants changed, so
`hid-grant-watch.ts` asks, on each change, whether an app that has approved devices still holds `devices.hid` live or on
disk; the disk side covers an app not opened this session.

**The `hid` check arrives with no page attached.** Before a chooser can open Electron asks "may this origin request a
device" with a null web contents (measured), so `hid-site-asker.ts` answers that from the origin alone. The frame is
then checked where it is known: `hid-select.ts` serves only a tab's top frame.

**Sessions that are not tabs answer no for every device themselves.** Electron's device handler gets an origin and a device
and no page, and the gate installs the same handler on every session, so the web-context session, the child-host session and
each embed partition each set `setDevicePermissionHandler(() => false)` next to their deny-all permission handlers. Without
it a document there, at an origin a tab was given a device for, would be handed that device by `getDevices()`.
