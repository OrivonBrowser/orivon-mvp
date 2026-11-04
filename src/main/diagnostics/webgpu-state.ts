// Whether WebGPU works on this computer and, when it does not, why: a pure function over what Chromium reports
// about the graphics setup, so the wording and the reasons are tested without Electron. Durable.
//
// The reasons are the ones Chromium 152 gives (docs/planning/webgpu-plan.md, "Why Linux is narrow"). A fact the
// inputs cannot show is never a reason: the answer is then 'unknown'.

export type WebGpuStateName = 'available' | 'unavailable' | 'unknown'

export type WebGpuReason =
  | 'adapter'
  | 'x11'
  | 'gpu-not-listed'
  | 'software-only'
  | 'webgpu-off'
  | 'maker-unsupported'
  | 'no-adapter'
  | 'unknown'

export interface WebGpuDevice {
  readonly vendorId: number
  readonly active: boolean
  /** `driverVendor`, such as `Mesa` or `NVIDIA`; empty when the platform does not report one. */
  readonly driverVendor: string
  readonly driverVersion: string
}

/** What a page learned by asking for an adapter: it got one, it got none, or its `navigator.gpu` does not exist. */
export type AdapterReading = { readonly kind: 'adapter' } | { readonly kind: 'none' } | { readonly kind: 'no-api' }

export interface WebGpuInputs {
  /** `process.platform`. */
  readonly platform: string
  /** The Ozone platform the browser runs on (`x11`, `wayland`), or '' when it cannot be told. */
  readonly ozone: string
  /** `app.getGPUFeatureStatus()`, string entries only. */
  readonly features: Readonly<Record<string, string>>
  /** The devices in `getGPUInfo('basic')`; undefined when that report could not be read. */
  readonly devices: readonly WebGpuDevice[] | undefined
  readonly adapter?: AdapterReading
}

export interface WebGpuState {
  readonly state: WebGpuStateName
  readonly reason: WebGpuReason
  /** One plain sentence for the person. */
  readonly sentence: string
}

const MAKERS: Readonly<Record<number, string>> = {
  0x8086: 'Intel',
  0x10de: 'NVIDIA',
  0x1002: 'AMD',
  0x106b: 'Apple',
  0x1414: 'Microsoft',
  0x1ae0: 'Google (SwiftShader)',
  0x5143: 'Qualcomm',
  0x13b5: 'Arm'
}

/** The maker behind a PCI vendor id, or undefined for one Orivon does not name. */
export function gpuMakerName (vendorId: number): string | undefined {
  return MAKERS[vendorId]
}

/** Chromium reports a CPU renderer under Google's SwiftShader id, or under Mesa's software id. */
const SOFTWARE_VENDORS: ReadonlySet<number> = new Set([0x1ae0, 0x10005])

/** The makers whose graphics cards Chromium's Dawn accepts on Windows (Qualcomm only with recent drivers, which a report cannot show). */
const WINDOWS_MAKERS: ReadonlySet<number> = new Set([0x1002, 0x8086, 0x10de, 0x5143])

const isOn = (status: string | undefined): boolean => status !== undefined && status.startsWith('enabled')

/** A feature Chromium reports as off, as opposed to one it does not report at all. */
const isOff = (status: string | undefined): boolean => status !== undefined && (status.startsWith('disabled') || status.startsWith('unavailable') || status.includes('blocklisted'))

const isSoftware = (status: string | undefined): boolean => status !== undefined && status.includes('software')

function result (state: WebGpuStateName, reason: WebGpuReason, sentence: string): WebGpuState {
  return { state, reason, sentence }
}

/** The device Chromium draws with, or the first one when none is marked. */
function mainDevice (devices: readonly WebGpuDevice[]): WebGpuDevice | undefined {
  return devices.find((device) => device.active) ?? devices[0]
}

function makerOf (device: WebGpuDevice): string {
  return gpuMakerName(device.vendorId) ?? `the maker 0x${device.vendorId.toString(16).padStart(4, '0')}`
}

function driverOf (device: WebGpuDevice): string {
  return [device.driverVendor, device.driverVersion].filter((part) => part !== '').join(' ')
}

function unlisted (devices: readonly WebGpuDevice[] | undefined): WebGpuState {
  const device = devices === undefined ? undefined : mainDevice(devices)
  const head = 'WebGPU is off because Chromium turns it on for only a few graphics drivers on Linux, and '
  if (device === undefined) return result('unavailable', 'gpu-not-listed', `${head}this computer's is not among them.`)
  const driver = driverOf(device)
  const named = driver === '' ? makerOf(device) : `${makerOf(device)}, driver ${driver}`
  return result('unavailable', 'gpu-not-listed', `${head}this one (${named}) is not among them.`)
}

/** Whether pages are drawn on the processor: Chromium blocks WebGPU there. Windows is left out because its software
 * renderer (WARP) is a device Chromium accepts. */
function drawsInSoftware (inputs: WebGpuInputs): boolean {
  if (inputs.platform === 'win32') return false
  const { features, devices } = inputs
  if (isSoftware(features['gpu_compositing']) || isSoftware(features['webgpu'])) return true
  return devices !== undefined && devices.every((device) => SOFTWARE_VENDORS.has(device.vendorId))
}

/** Linux reaches the graphics card through a bridge Chromium sets only on Wayland, and only for listed drivers. */
function linuxBridge (inputs: WebGpuInputs): WebGpuState | undefined {
  const bridge = inputs.features['webgpu_on_vk_via_gl_interop']
  if (inputs.platform !== 'linux' || bridge === undefined || isOn(bridge)) return undefined
  if (inputs.ozone === 'x11') {
    return result('unavailable', 'x11', 'WebGPU is off because this computer runs an X11 session. Chromium turns it off there for every graphics card.')
  }
  return inputs.ozone === 'wayland' ? unlisted(inputs.devices) : undefined
}

function windowsMaker (inputs: WebGpuInputs): WebGpuState | undefined {
  if (inputs.platform !== 'win32' || inputs.devices === undefined) return undefined
  const device = mainDevice(inputs.devices)
  // Vendor id 0 is a device whose report named nothing: not a maker to blame.
  if (device === undefined || device.vendorId === 0 || WINDOWS_MAKERS.has(device.vendorId) || device.vendorId === 0x1414) return undefined
  return result('unavailable', 'maker-unsupported',
    `WebGPU is off because Chromium supports it on Windows only for AMD, Intel, NVIDIA and Qualcomm graphics cards, and this one is from ${makerOf(device)}.`)
}

/** What can be said of WebGPU on this computer. 'available' needs a page that got an adapter; main alone can only
 * rule WebGPU out, so the report of a working computer reads 'unknown'. */
export function webGpuState (inputs: WebGpuInputs): WebGpuState {
  if (inputs.adapter?.kind === 'adapter') return result('available', 'adapter', 'WebGPU works on this computer.')
  if (drawsInSoftware(inputs)) {
    return result('unavailable', 'software-only', 'WebGPU needs a graphics card. This computer draws pages on its processor, and Chromium does not allow WebGPU there.')
  }
  const blocked = linuxBridge(inputs) ?? windowsMaker(inputs)
  if (blocked !== undefined) return blocked
  if (isOff(inputs.features['webgpu'])) return result('unavailable', 'webgpu-off', 'Chromium has turned WebGPU off on this computer.')
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

/** What Electron reports about the graphics setup, before it is shaped for `webGpuState`. */
export interface GraphicsReading {
  readonly platform: string
  readonly ozone: string
  /** `app.getGPUFeatureStatus()`. */
  readonly status: unknown
  /** `app.getGPUInfo('basic')`, or undefined when it rejected. */
  readonly info: unknown
  readonly adapter?: AdapterReading | undefined
}

function record (value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/** The devices in the basic report. Undefined unless the report has a device list: a report that could not be
 * read, or that has none to give, must not read as a computer without a graphics card. */
function devicesOf (info: unknown): readonly WebGpuDevice[] | undefined {
  const list = record(info)['gpuDevice']
  if (!Array.isArray(list)) return undefined
  return list.map((entry) => {
    const device = record(entry)
    return {
      vendorId: typeof device['vendorId'] === 'number' ? device['vendorId'] : 0,
      active: device['active'] === true,
      driverVendor: typeof device['driverVendor'] === 'string' ? device['driverVendor'] : '',
      driverVersion: typeof device['driverVersion'] === 'string' ? device['driverVersion'] : ''
    }
  })
}

export function webGpuInputsFrom (reading: GraphicsReading): WebGpuInputs {
  const features = Object.fromEntries(Object.entries(record(reading.status)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  return {
    platform: reading.platform,
    ozone: reading.ozone,
    features,
    devices: devicesOf(reading.info),
    ...(reading.adapter === undefined ? {} : { adapter: reading.adapter })
  }
}
