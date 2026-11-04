// The opt-in that gives WebGPU on an X11 session: whether it applies, the switches it sets, and the guard that
// turns it off after a run that went wrong. Pure but for the command line it is handed. Durable.
//
// The reasons for the shape (why these switches, why a guard, what is not measured) are in README.md, Design notes.
import { isOrdinaryEnd } from '../diagnostics/shell-console.js'
import { listFeature } from '../privacy/gpc-switch.js'
import type { FeatureSwitches } from '../privacy/gpc-switch.js'

/** The ANGLE backend to composite with. */
export const X11_ANGLE_BACKEND = 'vulkan'

/** `Vulkan` makes an adapter appear; `VulkanFromANGLE` keeps WebGL working beside it. */
export const X11_VULKAN_FEATURES: readonly string[] = ['Vulkan', 'VulkanFromANGLE']

export interface DisplayServer {
  readonly platform: string
  /** The `ozone-platform` switch as the command line holds it, or '' when none is set (yet). */
  readonly ozoneSwitch: string
  /** `XDG_SESSION_TYPE`, or '' when the system names none. */
  readonly sessionType: string
}

/**
 * The Ozone platform Chromium draws through, or '' off Linux. A switch that is set is what Chromium resolved, or what the
 * person asked for, and wins. With none, Electron 44 (Chromium 152.0.7977.130) has `ElectronMainDelegate` call
 * `SetOzonePlatformForLinuxIfNeeded` before any script runs: Wayland when `XDG_SESSION_TYPE` is `wayland`, X11 otherwise.
 * `WAYLAND_DISPLAY` is not read there (it belongs to `--ozone-platform-hint=auto`, which Electron does not use).
 */
export function ozonePlatformOf ({ platform, ozoneSwitch, sessionType }: DisplayServer): string {
  if (platform !== 'linux') return ''
  if (ozoneSwitch !== '') return ozoneSwitch
  return sessionType === 'wayland' ? 'wayland' : 'x11'
}

/** Where the setting applies and Settings offers it: Ozone X11 on a session that is not Wayland. Orivon on X11 inside a Wayland session (XWayland) is told to run on Wayland instead, so neither the row nor the switches reach it. */
export function offersX11Setting (display: DisplayServer): boolean {
  return ozonePlatformOf(display) === 'x11' && display.sessionType !== 'wayland'
}

/** Composites through Vulkan, so the adapter needs no GL bridge. The features already listed stay. */
export function applyX11Vulkan (commandLine: FeatureSwitches): void {
  commandLine.appendSwitch('use-angle', X11_ANGLE_BACKEND)
  for (const feature of X11_VULKAN_FEATURES) listFeature(commandLine, 'enable-features', feature)
}

/** Why Orivon turned the setting off: the graphics process ended badly, or fell back to drawing on the processor, or a run with the switches never showed its window. */
export type RevertWhy = 'gpu-crash' | 'gpu-software' | 'no-window'

export interface Revert {
  /** When, as an ISO date. */
  readonly at: string
  readonly why: RevertWhy
}

/** What the profile keeps between runs for the guard. */
export interface GuardRecord {
  /** A run applied the switches and its first window has not painted. */
  readonly pendingWindow: boolean
  readonly revert: Revert | null
}

export const NO_GUARD_RECORD: GuardRecord = { pendingWindow: false, revert: null }

const REVERT_REASONS: readonly RevertWhy[] = ['gpu-crash', 'gpu-software', 'no-window']

/** The record a file holds. It is data: anything that is not a record reads as none. */
export function guardRecordFrom (parsed: unknown): GuardRecord {
  if (typeof parsed !== 'object' || parsed === null) return NO_GUARD_RECORD
  const { pendingWindow, revert } = parsed as { pendingWindow?: unknown, revert?: unknown }
  const { at, why } = typeof revert === 'object' && revert !== null ? revert as { at?: unknown, why?: unknown } : { at: undefined, why: undefined }
  const known = typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? REVERT_REASONS.find((reason) => reason === why) : undefined
  return { pendingWindow: pendingWindow === true, revert: known !== undefined && typeof at === 'string' ? { at, why: known } : null }
}

export const sameGuardRecord = (a: GuardRecord, b: GuardRecord): boolean =>
  a.pendingWindow === b.pendingWindow && a.revert?.at === b.revert?.at && a.revert?.why === b.revert?.why

export interface StartPlan {
  /** The run sets the switches. */
  readonly applySwitches: boolean
  /** The saved setting is turned off before anything reads it. */
  readonly turnOff: boolean
  /** What the profile keeps from here. */
  readonly record: GuardRecord
}

/**
 * What a start does. Off an X11 session the setting means nothing and the record is left as it was. A setting that reads
 * on beside a revert in the record is a turn-off the settings store did not save in time (it saves after a delay):
 * the switches stay off, the setting is turned off again and the record stays. Turning the setting on from Settings
 * clears the record at once (`turnedOn`), so a revert still there means that was not the case.
 */
export function planStart ({ onX11, setting, record, now }: { readonly onX11: boolean, readonly setting: boolean, readonly record: GuardRecord, readonly now: Date }): StartPlan {
  if (!onX11) return { applySwitches: false, turnOff: false, record }
  if (!setting) return { applySwitches: false, turnOff: false, record: { ...record, pendingWindow: false } }
  if (record.revert !== null) return { applySwitches: false, turnOff: true, record: { pendingWindow: false, revert: record.revert } }
  if (record.pendingWindow) return { applySwitches: false, turnOff: true, record: { pendingWindow: false, revert: { at: now.toISOString(), why: 'no-window' } } }
  return { applySwitches: true, turnOff: false, record: { pendingWindow: true, revert: null } }
}

/** The first window of a run painted, or Orivon itself ended the start: the run got as far as the guard asks. */
export const windowPainted = (record: GuardRecord): GuardRecord => record.pendingWindow ? { ...record, pendingWindow: false } : record

/** The setting was turned on again: the last revert no longer describes it. */
export const turnedOn = (record: GuardRecord): GuardRecord => record.revert === null ? record : { ...record, revert: null }

/** The revert a child process's end calls for: only the graphics process, only in a run that set the switches, never while Orivon quits or starts again (every process ends then, whatever the reason says), and only an end the diagnostics also count as a problem. */
export function revertAfterEnd ({ applied, processType, reason, quitting, now }: { readonly applied: boolean, readonly processType: string, readonly reason: string, readonly quitting: boolean, readonly now: Date }): Revert | undefined {
  if (!applied || quitting || processType !== 'GPU' || isOrdinaryEnd('child', reason, quitting)) return undefined
  return { at: now.toISOString(), why: 'gpu-crash' }
}

/** How long after the first window the guard looks at how the pages are drawn: a graphics process that cannot start gives up within the first second. */
export const SOFTWARE_CHECK_MS = 10_000

/** The revert a run calls for when it set the switches and Chromium draws pages on the processor anyway (`gpu_compositing` is not `enabled`): the graphics process could not start with them, which no end of a process reports. */
export function revertAfterStatus ({ applied, compositing, now }: { readonly applied: boolean, readonly compositing: string | undefined, readonly now: Date }): Revert | undefined {
  if (!applied || compositing === undefined || compositing.startsWith('enabled')) return undefined
  return { at: now.toISOString(), why: 'gpu-software' }
}

/** What a report and `orivon://gpu` need to know of the setting. */
export interface X11Reading {
  /** The switches were set at this run's start: the setting was on, on an X11 session, and the guard let it stand. */
  readonly onAtStart: boolean
  /** The last time the guard turned the setting off, until it is turned on again. */
  readonly revert: Revert | null
}
