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
  | 'x11-vulkan-no-adapter'
  | 'x11-vulkan-reverted'
  | 'gpu-not-listed'
  | 'software-only'
  | 'webgpu-off'
  | 'maker-unsupported'
  | 'no-adapter'
  | 'unknown'

/** What the setting that gives an X11 session WebGPU (src/main/graphics/README.md) did in this run. */
export interface X11VulkanReading {
  /** The run drew through Vulkan because the setting was on when Orivon started. */
  readonly onAtStart: boolean
  /** Orivon turned the setting off after a bad run, and it has not been turned on again. */
  readonly reverted: boolean
}

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
  /** What a page learned by asking for an adapter; undefined when no page asked. */
  readonly adapter?: AdapterReading | undefined
  /** What the X11 setting did in this run; undefined where the reader has no such reading. */
  readonly x11Vulkan?: X11VulkanReading | undefined
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

const isSoftwareDevice = (device: GpuDevice): boolean => device.vendorId !== undefined && SOFTWARE_VENDORS.has(device.vendorId)

/** The card in "Chromium gave <this card> no WebGPU adapter": its maker and driver when the report names them. */
function oneCard (device: GpuDevice | undefined): string {
  if (device === undefined) return 'this graphics card'
  const maker = makerNameOf(device)
  const driver = driverOf(device)
  return `${maker === '' ? 'this graphics card' : `this graphics card (${maker})`} with ${driver === '' ? 'this driver' : `this driver (${driver})`}`
}

/** Each maker once, in device order, for "none of this computer's graphics cards". */
function noneOf (cards: readonly GpuDevice[]): string {
  const makers = [...new Set(cards.map(makerNameOf).filter((maker) => maker !== ''))]
  return `none of this computer's graphics cards${makers.length === 0 ? '' : ` (${makers.join(', ')})`}`
}

/** Linux gives no adapter to a card or driver that is not on Chromium's list. The report does not say which card the
 * page was offered (on a hybrid computer `active` can mark a card other than the one compositing uses), so two or
 * more cards are named together, never one of them. */
function unlisted (devices: readonly GpuDevice[] | undefined): WebGpuState {
  const cards = (devices ?? []).filter((device) => !isSoftwareDevice(device))
  const gave = cards.length > 1 ? `${noneOf(cards)} a WebGPU adapter` : `${oneCard(cards[0])} no WebGPU adapter`
  return result('unavailable', 'gpu-not-listed', `WebGPU is off because Chromium gave ${gave}. On Linux it does that for every card and driver not on its list.`)
}

/** Whether pages are drawn on the processor: Chromium blocks WebGPU there. Windows is left out because its software
 * renderer (WARP) is a device Chromium accepts. */
function drawsInSoftware (inputs: WebGpuInputs): boolean {
  if (inputs.platform === 'win32') return false
  const { features, devices } = inputs
  if (isSoftware(features['gpu_compositing']) || isSoftware(features['webgpu'])) return true
  return devices !== undefined && devices.every(isSoftwareDevice)
}

/** Where Settings offers the X11 setting: an X11 session. Under XWayland the way Orivon was started, not the setting, is what to change. */
const offersSetting = (session: string): boolean => session !== 'wayland'

const IN_SETTINGS = 'in Settings, under Performance.'

/** Chromium's X11 platform never turns on the bridge WebGPU needs, so it is off for every card there unless the
 * setting that draws through Vulkan is on. A Wayland session whose browser runs through XWayland is told apart: the
 * session allows WebGPU and the way Orivon was started does not. */
function x11Reason (session: string): WebGpuState {
  if (!offersSetting(session)) {
    return result('unavailable', 'xwayland', 'WebGPU is off because Orivon is running through X11 (XWayland) on this Wayland session. WebGPU needs Orivon to run on Wayland.')
  }
  const where = session === 'x11' ? 'this computer runs an X11 session' : 'Orivon is running on X11'
  return result('unavailable', 'x11', `WebGPU is off because ${where}. Chromium turns it off there for every graphics card. You can turn it on ${IN_SETTINGS}`)
}

/** The setting is on and the page still got no adapter: Vulkan found no card Chromium could use. */
const vulkanFoundNone = (): WebGpuState =>
  result('unavailable', 'x11-vulkan-no-adapter', 'WebGPU is still off with "Use the graphics card for WebGPU on X11" turned on: Chromium found no graphics card it could use through Vulkan.')

/** Orivon turned the setting off after a bad run. The line about turning it on again is left out where Settings does not offer it. */
function vulkanReverted (session: string): WebGpuState {
  const again = offersSetting(session) ? ` You can turn it on again ${IN_SETTINGS}` : ''
  return result('unavailable', 'x11-vulkan-reverted', `Orivon turned off "Use the graphics card for WebGPU on X11" because the graphics process crashed while it was on.${again}`)
}

/** A revert is the reason while the setting is off this run, or while the run that has it on got no adapter. It comes
 * before the processor check: a bad run is what leaves pages drawn there. */
function revertedReason (inputs: WebGpuInputs): WebGpuState | undefined {
  const { x11Vulkan, adapter } = inputs
  if (inputs.platform !== 'linux' || inputs.ozone !== 'x11' || x11Vulkan?.reverted !== true || adapter?.kind === 'no-api') return undefined
  return x11Vulkan.onAtStart && adapter?.kind !== 'none' ? undefined : vulkanReverted(inputs.session)
}

/** On Linux the Ozone platform decides, and the `webgpu_on_vk_via_gl_interop` status is not read: it reads enabled on
 * real graphics cards under X11 and Wayland while the page's `requestAdapter()` still returns null (measured). On X11
 * main rules WebGPU out alone, unless the run draws through Vulkan: then only a page that got none says so. On Wayland
 * a listed card can get an adapter, so only a page that got none says so. A page with no `navigator.gpu` says nothing
 * about the platform. */
function linuxReason (inputs: WebGpuInputs): WebGpuState | undefined {
  const asked = inputs.adapter?.kind
  if (inputs.platform !== 'linux' || asked === 'no-api') return undefined
  if (inputs.ozone === 'x11') {
    if (inputs.x11Vulkan?.onAtStart !== true) return x11Reason(inputs.session)
    return asked === 'none' ? vulkanFoundNone() : undefined
  }
  return inputs.ozone === 'wayland' && asked === 'none' ? unlisted(inputs.devices) : undefined
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
  const reverted = revertedReason(inputs)
  if (reverted !== undefined) return reverted
  if (drawsInSoftware(inputs)) {
    return result('unavailable', 'software-only',
      'WebGPU is off because this computer draws pages on its processor, and Chromium does not allow WebGPU there. Chromium does that when there is no graphics card, when it blocks the card\'s driver, or after its graphics process has crashed several times.')
  }
  const linux = linuxReason(inputs)
  if (linux !== undefined) return linux
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
