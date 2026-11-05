// The `diagnostics` block of a report: what this computer and this build are, shaped from facts main has already
// read. Every field is a plain number, a flag, or a short name; there is no address, path or free text in it, and
// the notice lists the groups (docs/privacy/notice.md, "Bug reports you send"). Pure, so the shape is tested.
import type { X11Reading } from '../graphics/x11-vulkan.js'
import { SETTINGS } from '../settings/schema.js'
import type { SettingKey } from '../settings/schema.js'
import { newest } from './crash-records.js'
import type { CrashKind, CrashRecord } from './crash-records.js'
import { gpuDevicesOf, gpuFeaturesOf } from './gpu-reading.js'
import { webGpuState, x11VulkanReadingOf } from './webgpu-state.js'
import type { AdapterReading, WebGpuReason, WebGpuStateName } from './webgpu-state.js'

/** What the person told sites about WebGPU (`sites.webgpu`, the per-site kind `webgpu`): the default, and how many sites are allowed and blocked. Counts only, never which sites. */
export interface WebGpuSitesReading {
  readonly default: string
  readonly allowed: number
  readonly blocked: number
}

/** How many sites hold an `allow` and how many a `block` for `kind`, from the per-site answers. */
export function siteAnswerCounts (entries: ReadonlyArray<{ readonly kind: string, readonly value: string }>, kind: string): { readonly allowed: number, readonly blocked: number } {
  let allowed = 0
  let blocked = 0
  for (const entry of entries) {
    if (entry.kind !== kind) continue
    if (entry.value === 'allow') allowed++
    else if (entry.value === 'block') blocked++
  }
  return { allowed, blocked }
}

export type Channel = 'development' | 'source' | 'appimage' | 'linux-package' | 'windows' | 'macos'

export interface ChannelInputs {
  readonly development: boolean
  readonly packaged: boolean
  readonly platform: string
  readonly appImage: boolean
}

/** How this copy of Orivon was started and installed. */
export function channelOf (inputs: ChannelInputs): Channel {
  if (inputs.development) return 'development'
  if (!inputs.packaged) return 'source'
  if (inputs.platform === 'win32') return 'windows'
  if (inputs.platform === 'darwin') return 'macos'
  return inputs.appImage ? 'appimage' : 'linux-package'
}

export interface ProcessReading {
  readonly type: string
  /** Electron's `workingSetSize`, in kilobytes. */
  readonly workingSetKb: number
}

export interface DisplayReading {
  readonly width: number
  readonly height: number
  readonly scaleFactor: number
}

export interface ExtensionReading {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly enabled: boolean
}

/** What one installed app holds in the broker against what it may hold: numbers only, so a report names no app. */
export interface AppSocketReading {
  /** Sockets, listeners and accepted connections it has open; what its allowance counts. */
  readonly open: number
  /** Calls it has running or waiting, among them every connection attempt that has not answered. */
  readonly inFlight: number
  readonly allowance: number
}

/** The most apps a report lists: the ones holding the most. */
export const REPORTED_APPS = 8

/** The apps that hold anything, the fullest first. An idle app says nothing about why another ran out. */
export function appSocketReadings (usages: readonly AppSocketReading[]): AppSocketReading[] {
  return usages
    .filter(({ open, inFlight }) => open > 0 || inFlight > 0)
    .sort((a, b) => b.open - a.open || b.inFlight - a.inFlight)
    .slice(0, REPORTED_APPS)
    .map(({ open, inFlight, allowance }) => ({ open, inFlight, allowance }))
}

export interface DiagnosticsFacts {
  readonly commit: string
  readonly channel: Channel
  readonly versions: { readonly electron: string, readonly chromium: string, readonly node: string, readonly v8: string }
  readonly packaged: boolean
  readonly uptimeSec: number
  readonly system: {
    readonly platform: string
    readonly release: string
    readonly arch: string
    readonly cpus: number
    readonly cpuModel: string
    readonly memoryMb: number
    readonly freeMemoryMb: number
    readonly locale: string
    readonly session: string
    readonly desktop: string
    readonly ozone: string
  }
  /** `app.getGPUFeatureStatus()`. */
  readonly gpuStatus: unknown
  /** What the setting that gives an X11 session WebGPU did in this run. */
  readonly x11Vulkan: X11Reading
  /** The WebGPU question: the default and the number of sites allowed and blocked. */
  readonly webgpuSites: WebGpuSitesReading
  /** `app.getGPUInfo('basic')`, or undefined when it rejected. */
  readonly gpuInfo: unknown
  readonly displays: readonly DisplayReading[]
  readonly processes: readonly ProcessReading[]
  readonly browser: {
    readonly windows: number
    readonly tabs: number
    readonly privateSession: boolean
    /** How many tabs carry each tunnel choice: counts only. */
    readonly tunnels: { readonly tabs: { readonly nym: number, readonly socks5: number, readonly direct: number } }
    readonly extensions: readonly ExtensionReading[]
    readonly appSockets: readonly AppSocketReading[]
    readonly settings: Readonly<Record<string, string | boolean>>
  }
  readonly crashes: readonly CrashRecord[]
}

export interface Diagnostics {
  readonly app: { readonly commit: string, readonly channel: Channel, readonly electron: string, readonly chromium: string, readonly node: string, readonly v8: string, readonly packaged: boolean, readonly uptimeSec: number }
  readonly system: DiagnosticsFacts['system']
  readonly gpu: {
    readonly features: Readonly<Record<string, string>>
    readonly devices: ReadonlyArray<{ readonly vendorId: number, readonly deviceId: number, readonly driverVersion: string, readonly active: boolean }>
    /** Whether WebGPU works and why not: main cannot ask for an adapter, so a working computer reads `unknown` unless the page that asked for the report got one. */
    readonly webgpu: { readonly state: WebGpuStateName, readonly reason: WebGpuReason }
    /** The X11 setting for WebGPU: whether this run drew through Vulkan because it was on at the start, and the last time Orivon turned it off by itself (a fixed word for why). */
    readonly x11Vulkan: X11Reading
    /** The question a website is asked before it gets WebGPU: what it defaults to, and how many sites are allowed and blocked (numbers, never which). */
    readonly webgpuSites: WebGpuSitesReading
  }
  readonly displays: ReadonlyArray<{ readonly width: number, readonly height: number, readonly scale: number }>
  readonly processes: ReadonlyArray<{ readonly type: string, readonly count: number, readonly memoryMb: number }>
  readonly browser: DiagnosticsFacts['browser']
  readonly recentCrashes: ReadonlyArray<{ readonly kind: CrashKind, readonly at: string, readonly process: string, readonly reason: string, readonly exitCode: number | null }>
}

/** How many local crash records a report lists. */
export const RECENT_CRASHES = 10

/** The settings a report states, as values only: a switch or one of a fixed list of choices, never an address, a path or text a person typed. `web3.*` joins whichever of its settings is a switch or a choice. */
export const REPORTED_SETTINGS: readonly SettingKey[] = [
  'appearance.theme', 'privacy.cookies', 'privacy.globalPrivacyControl', 'privacy.doNotTrack', 'privacy.httpsOnly', 'privacy.secureDns',
  'performance.memorySaver', 'performance.energySaver', 'graphics.webgpuOnX11', 'startup.mode', 'spellcheck.enabled', 'developer.tools', 'extensions.developerMode', 'updates.check',
  'network.route.kind', 'network.nym.enabled', 'network.tunnel.everywhere',
  ...(Object.keys(SETTINGS) as SettingKey[]).filter((key) => key.startsWith('web3.') && (SETTINGS[key].kind === 'bool' || SETTINGS[key].kind === 'enum'))
]

export function reportedSettings (get: (key: SettingKey) => unknown): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {}
  for (const key of REPORTED_SETTINGS) {
    const value = get(key)
    if (typeof value === 'string' || typeof value === 'boolean') values[key] = value
  }
  return values
}

function groupProcesses (readings: readonly ProcessReading[]): Diagnostics['processes'] {
  const groups = new Map<string, { count: number, kb: number }>()
  for (const reading of readings) {
    const group = groups.get(reading.type) ?? { count: 0, kb: 0 }
    groups.set(reading.type, { count: group.count + 1, kb: group.kb + reading.workingSetKb })
  }
  return [...groups].map(([type, { count, kb }]) => ({ type, count, memoryMb: Math.round(kb / 1024) }))
}

export function buildDiagnostics (facts: DiagnosticsFacts, adapter?: AdapterReading): Diagnostics {
  const features = gpuFeaturesOf(facts.gpuStatus)
  const devices = gpuDevicesOf(facts.gpuInfo)
  const { platform, session, ozone } = facts.system
  const { x11Vulkan } = facts
  const webgpu = webGpuState({ platform, session, ozone, features, devices, adapter, x11Vulkan: x11VulkanReadingOf(x11Vulkan), webgpuDefaultBlocks: facts.webgpuSites.default === 'block' })
  return {
    app: { commit: facts.commit, channel: facts.channel, ...facts.versions, packaged: facts.packaged, uptimeSec: Math.round(facts.uptimeSec) },
    system: facts.system,
    gpu: {
      features,
      devices: (devices ?? []).map(({ vendorId, deviceId, driverVersion, active }) => ({ vendorId: vendorId ?? 0, deviceId: deviceId ?? 0, driverVersion, active })),
      webgpu: { state: webgpu.state, reason: webgpu.reason },
      x11Vulkan,
      webgpuSites: facts.webgpuSites
    },
    displays: facts.displays.map((display) => ({ width: display.width, height: display.height, scale: display.scaleFactor })),
    processes: groupProcesses(facts.processes),
    browser: facts.browser,
    recentCrashes: newest(facts.crashes, RECENT_CRASHES).map(({ kind, at, process, reason, exitCode }) => ({ kind, at, process, reason, exitCode }))
  }
}
