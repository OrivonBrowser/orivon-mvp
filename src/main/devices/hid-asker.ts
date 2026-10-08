// "Connect <device> to <app>?": the question an app is asked, in its own tab, the first time a device its grant
// matches shows up (ADR-0068). One open question per origin and device; Allow remembers the device and tells the
// origin's pages it has appeared, anything else keeps it away until the browser restarts. Pure over its dependencies.
import { deviceKey, type HidDeviceInfo } from './hid-policy.js'
import type { QuestionResult, QuestionSpec } from '../shell/question/question-spec.js'

export interface HidAskerDeps<Tab> {
  /** The tab to ask in: the origin's visible one, else its most recent. */
  readonly tabOf: (origin: string) => Tab | undefined
  readonly appName: (origin: string) => Promise<string | undefined>
  /** The tab is still open and still on the origin that was asked about. */
  readonly isAlive: (tab: Tab, origin: string) => boolean
  readonly question: (tab: Tab, spec: QuestionSpec) => Promise<QuestionResult>
  readonly approve: (origin: string, device: HidDeviceInfo) => void
  readonly decline: (origin: string, device: HidDeviceInfo) => void
  /** Tells every page of the origin that these devices are now usable. */
  readonly announce: (origin: string, devices: readonly HidDeviceInfo[]) => void
}

export interface HidAsker {
  ask: (origin: string, device: HidDeviceInfo) => void
}

const ALLOW = 0
const hex = (value: number): string => value.toString(16).padStart(4, '0')

/** How the question names a device: its own words for itself, then its USB ids, the one thing a person can look up. */
export function describeHidDevice (device: HidDeviceInfo): string {
  const ids = `USB ${hex(device.vendorId)}:${hex(device.productId)}`
  return device.name === undefined || device.name === '' ? `a device (${ids})` : `${device.name} (${ids})`
}

export function createHidAsker<Tab> (deps: HidAskerDeps<Tab>): HidAsker {
  const open = new Set<string>()

  async function run (origin: string, device: HidDeviceInfo, tab: Tab): Promise<void> {
    const app = await deps.appName(origin) ?? origin
    const serial = device.serialNumber === undefined || device.serialNumber === '' ? '' : `Serial number: ${device.serialNumber}\n`
    const result = await deps.question(tab, {
      kind: 'consent',
      message: `Connect ${describeHidDevice(device)} to ${app}?`,
      detail: `${serial}The app may use USB devices of this kind, but only the ones you allow. You can take this one back in Settings, under Apps.`,
      origin,
      buttons: ['Allow', 'Not now'],
      cancelId: 1,
      guarded: [ALLOW],
      focus: 'dialog'
    })
    // A tab that closed or moved on during the question never answered it: the device is asked about again.
    if (!deps.isAlive(tab, origin)) return
    if (result.response === ALLOW) {
      deps.approve(origin, device)
      deps.announce(origin, [device])
    } else {
      deps.decline(origin, device)
    }
  }

  return {
    ask (origin, device) {
      const id = `${origin}\n${deviceKey(device)}`
      if (open.has(id)) return
      const tab = deps.tabOf(origin)
      if (tab === undefined) return
      open.add(id)
      run(origin, device, tab).catch((error: unknown) => {
        console.error('[hid] the device question failed:', error)
      }).finally(() => { open.delete(id) })
    }
  }
}
