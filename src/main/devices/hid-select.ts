// `navigator.hid.requestDevice()`: Electron's `select-hid-device`. Without this handler Electron picks the first
// device for the page; here the person picks from Orivon's own sheet, and the pick is the approval (ADR-0068). Pure
// over its dependencies.
import type { ChooserSpec } from '../auth/chooser-store.js'
import { chooserSpecFor, pickedDevice } from './hid-chooser.js'
import type { HidGate } from './hid-gate.js'
import { hidInfoOf, type HidDeviceInfo } from './hid-policy.js'

export interface HidSelectDeps<Frame> {
  readonly gate: HidGate
  /** Where the sheet goes: the committed origin of the tab whose top frame asked. Null for any other frame, which is cancelled. */
  readonly target: (frame: Frame | null) => { readonly origin: string, readonly ask: (spec: ChooserSpec) => Promise<string | null> } | null
  readonly approve: (origin: string, device: HidDeviceInfo) => void
}

interface Details<Frame> {
  readonly deviceList: readonly unknown[]
  readonly frame: Frame | null
}

export function handleSelectHidDevice<Frame> (
  deps: HidSelectDeps<Frame>,
  event: { preventDefault: () => void },
  details: Details<Frame>,
  callback: (deviceId?: string | null) => void
): void {
  // Without this Electron answers with the first device in the list, which would hand a page hardware nobody chose.
  event.preventDefault()
  const target = deps.target(details.frame)
  if (target === null) { callback(''); return }
  const deviceIds = new Map<HidDeviceInfo, string>()
  const listed: HidDeviceInfo[] = []
  for (const entry of details.deviceList) {
    const info = hidInfoOf(entry)
    const deviceId = info === null ? undefined : (entry as { deviceId?: unknown }).deviceId
    if (info === null || typeof deviceId !== 'string') continue
    deviceIds.set(info, deviceId)
    listed.push(info)
  }
  const offered = deps.gate.chooserDevices(target.origin, listed)
  if (offered === null) { callback(''); return }
  const answer = async (): Promise<void> => {
    const picked = pickedDevice(offered, await target.ask(chooserSpecFor(target.origin, offered)))
    const deviceId = picked === undefined ? undefined : deviceIds.get(picked)
    if (picked === undefined || deviceId === undefined) { callback(''); return }
    // Once a device permission handler is set, Chromium keeps a pick only if the handler says yes for that device.
    deps.approve(target.origin, picked)
    callback(deviceId)
  }
  answer().catch((error: unknown) => {
    console.error('[hid] the device chooser failed:', error)
    callback('')
  })
}
