// The `diagnostics` block of a report: what this computer and this build are, shaped from facts main has already
// read. Every field is a plain number, a flag, or a short name; there is no address, path or free text in it, and
// the notice lists the groups (docs/privacy/notice.md, "Bug reports you send"). Pure, so the shape is tested.
import { SETTINGS } from '../settings/schema.js'
import type { SettingKey } from '../settings/schema.js'
import { newest } from './crash-records.js'
import type { CrashKind, CrashRecord } from './crash-records.js'

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
  /** `app.getGPUInfo('basic')`, or undefined when it rejected. */
  readonly gpuInfo: unknown
  readonly displays: readonly DisplayReading[]
  readonly processes: readonly ProcessReading[]
  readonly browser: {
    readonly windows: number
    readonly tabs: number
    readonly privateSession: boolean
    readonly extensions: readonly ExtensionReading[]
    readonly settings: Readonly<Record<string, string | boolean>>
  }
  readonly crashes: readonly CrashRecord[]
}

export interface Diagnostics {
  readonly app: { readonly commit: string, readonly channel: Channel, readonly electron: string, readonly chromium: string, readonly node: string, readonly v8: string, readonly packaged: boolean, readonly uptimeSec: number }
  readonly system: DiagnosticsFacts['system']
  readonly gpu: { readonly features: Readonly<Record<string, string>>, readonly devices: ReadonlyArray<{ readonly vendorId: number, readonly deviceId: number, readonly driverVersion: string, readonly active: boolean }> }
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
  'performance.memorySaver', 'performance.energySaver', 'startup.mode', 'spellcheck.enabled', 'developer.tools', 'extensions.developerMode', 'updates.check',
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

function record (value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function gpuDevices (info: unknown): Diagnostics['gpu']['devices'] {
  const list = record(info)['gpuDevice']
  if (!Array.isArray(list)) return []
  return list.map((entry) => {
    const device = record(entry)
    return {
      vendorId: typeof device['vendorId'] === 'number' ? device['vendorId'] : 0,
      deviceId: typeof device['deviceId'] === 'number' ? device['deviceId'] : 0,
      driverVersion: typeof device['driverVersion'] === 'string' ? device['driverVersion'] : '',
      active: device['active'] === true
    }
  })
}

function groupProcesses (readings: readonly ProcessReading[]): Diagnostics['processes'] {
  const groups = new Map<string, { count: number, kb: number }>()
  for (const reading of readings) {
    const group = groups.get(reading.type) ?? { count: 0, kb: 0 }
    groups.set(reading.type, { count: group.count + 1, kb: group.kb + reading.workingSetKb })
  }
  return [...groups].map(([type, { count, kb }]) => ({ type, count, memoryMb: Math.round(kb / 1024) }))
}

export function buildDiagnostics (facts: DiagnosticsFacts): Diagnostics {
  const features = Object.fromEntries(Object.entries(record(facts.gpuStatus)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  return {
    app: { commit: facts.commit, channel: facts.channel, ...facts.versions, packaged: facts.packaged, uptimeSec: Math.round(facts.uptimeSec) },
    system: facts.system,
    gpu: { features, devices: gpuDevices(facts.gpuInfo) },
    displays: facts.displays.map((display) => ({ width: display.width, height: display.height, scale: display.scaleFactor })),
    processes: groupProcesses(facts.processes),
    browser: facts.browser,
    recentCrashes: newest(facts.crashes, RECENT_CRASHES).map(({ kind, at, process, reason, exitCode }) => ({ kind, at, process, reason, exitCode }))
  }
}
