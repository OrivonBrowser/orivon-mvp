// Whether WebGPU works on this computer and, when it does not, why: a pure function over what Chromium reports
// about the graphics setup, so the wording and the reasons are tested without Electron. Durable.
//
// The reasons are the ones Chromium 152 gives (docs/planning/webgpu-plan.md, "Why Linux is narrow"). A fact the
// inputs cannot show is never a reason: the answer is then 'unknown'.
import { driverOf, hex4, makerNameOf } from './gpu-reading.js'
import type { GpuDevice } from './gpu-reading.js'

export type WebGpuStateName = 'available' | 'unavailable' | 'unknown'

export type WebGpuReason =
  | 'adapter'
  | 'x11'
  | 'xwayland'
  | 'gpu-not-listed'
  | 'software-only'
  | 'webgpu-off'
  | 'maker-unsupported'
  | 'no-adapter'
  | 'unknown'

/** What a page learned by asking for an adapter: it got one, it got none, or its `navigator.gpu` does not exist. */
export type AdapterReading = { readonly kind: 'adapter' } | { readonly kind: 'none' } | { readonly kind: 'no-api' }

export interface WebGpuInputs {
  /** `process.platform`. */
  readonly platform: string
  /** The desktop session (`XDG_SESSION_TYPE`: `x11`, `wayland`), or '' when the system names none. */
  readonly session: string
  /** The Ozone platform the browser runs on (`x11`, `wayland`), or '' when it cannot be told. */
  readonly ozone: string
  /** `app.getGPUFeatureStatus()`, string entries only. */
  readonly features: Readonly<Record<string, string>>
  /** The devices in `getGPUInfo('basic')`; undefined when that report could not be read. */
  readonly devices: readonly GpuDevice[] | undefined
  readonly adapter?: AdapterReading | undefined
}

export interface WebGpuState {
  readonly state: WebGpuStateName
  readonly reason: WebGpuReason
  /** One plain sentence for the person. */
  readonly sentence: string
}

/** Chromium reports a CPU renderer under Google's SwiftShader id, or under Mesa's software id. */
const SOFTWARE_VENDORS: ReadonlySet<number> = new Set([0x1ae0, 0x10005])

/** The makers whose adapters Chromium's Dawn accepts on Windows: AMD, Intel, NVIDIA, Qualcomm (only with recent drivers, which a report cannot show) and Microsoft, whose WARP is a software renderer Dawn takes. */
const WINDOWS_MAKERS: ReadonlySet<number> = new Set([0x1002, 0x8086, 0x10de, 0x5143, 0x1414])

const isOn = (status: string | undefined): boolean => status !== undefined && status.startsWith('enabled')

/** A feature Chromium reports as off, as opposed to one it does not report at all. */
const isOff = (status: string | undefined): boolean => status !== undefined && (status.startsWith('disabled') || status.startsWith('unavailable') || status.includes('blocklisted'))

const isSoftware = (status: string | undefined): boolean => status !== undefined && status.includes('software')

function result (state: WebGpuStateName, reason: WebGpuReason, sentence: string): WebGpuState {
  return { state, reason, sentence }
}

/** The device Chromium draws with, or the first one when none is marked. */
function mainDevice (devices: readonly GpuDevice[]): GpuDevice | undefined {
  return devices.find((device) => device.active) ?? devices[0]
}

function unlisted (devices: readonly GpuDevice[] | undefined): WebGpuState {
  const device = devices === undefined ? undefined : mainDevice(devices)
  const maker = device === undefined ? '' : makerNameOf(device)
  const driver = device === undefined ? '' : driverOf(device)
  const card = maker === '' ? 'this graphics card' : `this graphics card (${maker})`
  const withDriver = driver === '' ? 'this driver' : `this driver (${driver})`
  return result('unavailable', 'gpu-not-listed', `WebGPU is off because ${card} with ${withDriver} is not on Chromium's list for Wayland.`)
}

/** Whether pages are drawn on the processor: Chromium blocks WebGPU there. Windows is left out because its software
 * renderer (WARP) is a device Chromium accepts. */
function drawsInSoftware (inputs: WebGpuInputs): boolean {
  if (inputs.platform === 'win32') return false
  const { features, devices } = inputs
  if (isSoftware(features['gpu_compositing']) || isSoftware(features['webgpu'])) return true
  return devices !== undefined && devices.every((device) => device.vendorId !== undefined && SOFTWARE_VENDORS.has(device.vendorId))
}

/** On X11 the bridge is off for every card. A Wayland session whose browser runs through XWayland is told apart:
 * there the session allows WebGPU and the way Orivon was started does not. */
function x11Reason (session: string): WebGpuState {
  if (session === 'wayland') {
    return result('unavailable', 'xwayland', 'WebGPU is off because Orivon is running through X11 (XWayland) on this Wayland session. WebGPU needs Orivon to run on Wayland.')
  }
  const where = session === 'x11' ? 'this computer runs an X11 session' : 'Orivon is running on X11'
  return result('unavailable', 'x11', `WebGPU is off because ${where}. Chromium turns it off there for every graphics card.`)
}

/** Linux reaches the graphics card through a bridge Chromium sets only on Wayland, and only for listed drivers. */
function linuxBridge (inputs: WebGpuInputs): WebGpuState | undefined {
  const bridge = inputs.features['webgpu_on_vk_via_gl_interop']
  if (inputs.platform !== 'linux' || bridge === undefined || isOn(bridge)) return undefined
  if (inputs.ozone === 'x11') return x11Reason(inputs.session)
  return inputs.ozone === 'wayland' ? unlisted(inputs.devices) : undefined
}

/** A maker Dawn refuses leaves no adapter, but WARP may still give one, so the claim needs a page that saw none. */
function windowsMaker (inputs: WebGpuInputs): WebGpuState | undefined {
  if (inputs.platform !== 'win32' || inputs.adapter?.kind !== 'none' || inputs.devices === undefined) return undefined
  const device = mainDevice(inputs.devices)
  // A device whose report named no vendor is not a maker to blame.
  if (device === undefined || device.vendorId === undefined || device.vendorId === 0 || WINDOWS_MAKERS.has(device.vendorId)) return undefined
  const name = makerNameOf(device)
  const who = name === '' ? `has the vendor id ${hex4(device.vendorId)}` : `is from ${name}`
  return result('unavailable', 'maker-unsupported',
    `WebGPU is off because Chromium supports it on Windows only for AMD, Intel, NVIDIA and Qualcomm graphics cards, and this one ${who}.`)
}

/** What can be said of WebGPU on this computer. 'available' needs a page that got an adapter; main alone can only
 * rule WebGPU out, so a report with no page reading of a working computer reads 'unknown'. */
export function webGpuState (inputs: WebGpuInputs): WebGpuState {
  if (inputs.adapter?.kind === 'adapter') return result('available', 'adapter', 'WebGPU works on this computer.')
  if (drawsInSoftware(inputs)) {
    return result('unavailable', 'software-only',
      'WebGPU is off because this computer draws pages on its processor, and Chromium does not allow WebGPU there. Chromium does that when there is no graphics card, when it blocks the card\'s driver, or after its graphics process has crashed several times.')
  }
  const bridge = linuxBridge(inputs)
  if (bridge !== undefined) return bridge
  if (isOff(inputs.features['webgpu'])) return result('unavailable', 'webgpu-off', 'Chromium has turned WebGPU off on this computer.')
  const maker = windowsMaker(inputs)
  if (maker !== undefined) return maker
  if (inputs.adapter?.kind === 'none') {
    return result('unavailable', 'no-adapter', 'The page asked for a WebGPU adapter and got none. The graphics report does not say why.')
  }
  if (inputs.adapter?.kind === 'no-api') {
    return result('unavailable', 'no-adapter', 'This page has no WebGPU. The graphics report does not say why.')
  }
  return result('unknown', 'unknown', 'Orivon cannot tell from the graphics report whether WebGPU works on this computer.')
}

/** What a page may tell main about its adapter request: one of the three outcomes, and nothing else is believed. */
export function adapterReading (value: unknown): AdapterReading | undefined {
  const kind = typeof value === 'object' && value !== null ? (value as { kind?: unknown }).kind : undefined
  return kind === 'adapter' || kind === 'none' || kind === 'no-api' ? { kind } : undefined
}
