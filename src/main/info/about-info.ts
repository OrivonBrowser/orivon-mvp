// What the About page shows, as plain rows: built from facts main has already
// read, so the wording and the status mapping are tested without Electron.

export interface AboutFacts {
  readonly orivon: string
  readonly electron: string
  readonly chromium: string
  readonly node: string
  readonly v8: string
  readonly platform: string
  readonly osVersion: string
  readonly arch: string
  readonly language: string
  readonly userAgent: string
  readonly commandLine: string
  readonly programPath: string
  readonly profilePath: string
  readonly downloadsPath: string
  readonly isPrivate: boolean
}

export interface AboutRow {
  readonly label: string
  readonly value: string
  /** A path, a command or another long unbroken value: shown in a monospace face. */
  readonly mono: boolean
}

export const PRIVATE_PROFILE_TEXT = 'Private window (temporary, deleted when it closes)'

const OS_NAMES: Readonly<Record<string, string>> = { linux: 'Linux', win32: 'Windows', darwin: 'macOS' }

export function osName (platform: string): string {
  return OS_NAMES[platform] ?? platform
}

/** A private window's launch flags name its temporary profile folder, which the Profile folder row hides. A value runs
 * to the next flag, since a folder name may hold spaces. */
export function withoutPrivateDirectory (commandLine: string): string {
  return commandLine.replace(/(--(?:orivon-private-dir|user-data-dir)=).*?(?=\s--|$)/g, '$1<private>')
}

export function aboutRows (facts: AboutFacts): AboutRow[] {
  const row = (label: string, value: string, mono = false): AboutRow => ({ label, value, mono })
  const system = [osName(facts.platform), facts.osVersion].filter((part) => part !== '').join(' ')
  return [
    row('Orivon', facts.orivon),
    row('Electron', facts.electron),
    row('Chromium', facts.chromium),
    row('Node.js', facts.node),
    row('V8', facts.v8),
    row('Operating system', `${system} (${facts.arch})`),
    row('Language', facts.language),
    row('User agent', facts.userAgent, true),
    row('Command line', facts.isPrivate ? withoutPrivateDirectory(facts.commandLine) : facts.commandLine, true),
    row('Program location', facts.programPath, true),
    row('Profile folder', facts.isPrivate ? PRIVATE_PROFILE_TEXT : facts.profilePath, !facts.isPrivate),
    row('Downloads folder', facts.downloadsPath, true)
  ]
}

/** The table as the person would paste it: one "Label: value" line per row. */
export function aboutText (rows: readonly AboutRow[]): string {
  return rows.map((row) => `${row.label}: ${row.value}`).join('\n')
}

export type FeatureTone = 'ok' | 'warn' | 'danger' | 'neutral'

export interface FeatureRow {
  readonly key: string
  readonly label: string
  /** What the badge says. An unknown status is shown as reported. */
  readonly text: string
  readonly tone: FeatureTone
}

export interface DeviceRow {
  readonly vendor: string
  readonly device: string
  readonly driver: string
  readonly active: boolean
}

const FEATURE_LABELS: Readonly<Record<string, string>> = {
  '2d_canvas': 'Canvas',
  canvas_oop_rasterization: 'Canvas out-of-process rasterization',
  direct_rendering_display_compositor: 'Direct rendering display compositor',
  flash_3d: 'Flash 3D',
  flash_stage3d: 'Flash Stage3D',
  flash_stage3d_baseline: 'Flash Stage3D baseline',
  gpu_compositing: 'Compositing',
  multiple_raster_threads: 'Multiple raster threads',
  native_gpu_memory_buffers: 'Native GPU memory buffers',
  metal: 'Metal',
  opengl: 'OpenGL',
  raw_draw: 'Raw draw',
  rasterization: 'Rasterization',
  skia_graphite: 'Skia Graphite',
  surface_control: 'Surface control',
  trees_in_viz: 'Trees in Viz',
  video_decode: 'Video decode',
  video_encode: 'Video encode',
  vpx_decode: 'VPx decode',
  vulkan: 'Vulkan',
  webgl: 'WebGL',
  webgl2: 'WebGL 2',
  webgpu: 'WebGPU',
  webgpu_on_vk_via_gl_interop: 'WebGPU on Vulkan through GL interop',
  webnn: 'WebNN'
}

/** A status string Chromium reports for a feature, as a badge. The software case is tested first:
 * `disabled_software` means the feature runs, just not on the graphics card. Software rendering and a feature that is
 * simply off are expected on a computer without a graphics card, so neither is coloured as a fault; only a feature
 * that is blocklisted or unavailable is. */
export function featureTone (status: string): { text: string, tone: FeatureTone } {
  if (status.includes('software')) return { text: 'Software only', tone: 'neutral' }
  if (status.startsWith('enabled')) return { text: 'Hardware accelerated', tone: 'ok' }
  if (status.includes('blocklisted') || (status.startsWith('unavailable') && !status.endsWith('_ok'))) return { text: 'Disabled', tone: 'danger' }
  if (status.startsWith('disabled') || status.startsWith('unavailable')) return { text: 'Disabled', tone: 'neutral' }
  return { text: status === '' ? 'Unknown' : status, tone: 'neutral' }
}

export function featureRows (status: Readonly<Record<string, unknown>>): FeatureRow[] {
  return Object.entries(status)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => ({ key, label: FEATURE_LABELS[key] ?? key, ...featureTone(value) }))
}

const VENDORS: Readonly<Record<number, string>> = {
  0x8086: 'Intel',
  0x10de: 'NVIDIA',
  0x1002: 'AMD',
  0x106b: 'Apple',
  0x1414: 'Microsoft',
  0x1ae0: 'Google (SwiftShader)',
  0x5143: 'Qualcomm',
  0x13b5: 'Arm'
}

function hex (value: unknown): string {
  return typeof value === 'number' ? `0x${value.toString(16).padStart(4, '0')}` : ''
}

function text (value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asRecord (value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/** The devices in `getGPUInfo('basic')`. Every field is optional there, and which ones a platform fills differs. */
export function deviceRows (info: unknown): DeviceRow[] {
  const list = asRecord(info)['gpuDevice']
  if (!Array.isArray(list)) return []
  return list.map((entry) => {
    const device = asRecord(entry)
    const vendorId = device['vendorId']
    const vendorName = text(device['vendorString']) || (typeof vendorId === 'number' ? VENDORS[vendorId] : undefined) || ''
    const driver = [text(device['driverVendor']), text(device['driverVersion'])].filter((part) => part !== '').join(' ')
    return {
      vendor: [vendorName, vendorId === undefined ? '' : `(${hex(vendorId)})`].filter((part) => part !== '').join(' ') || 'Unknown',
      device: text(device['deviceString']) || hex(device['deviceId']) || 'Unknown',
      driver: driver === '' ? 'Not reported' : driver,
      active: device['active'] === true
    }
  })
}

/** The whole report, for the "Raw report" block and its Copy button. */
export function rawReport (status: unknown, info: unknown): string {
  return JSON.stringify({ featureStatus: status, gpuInfo: info }, null, 2)
}
