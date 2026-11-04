// Carries out the WebGPU-on-X11 setting in this process: the switches before Chromium reads them, the start marker
// that the first window clears, and the revert when the graphics process ends badly. What each step decides is in
// x11-vulkan.ts. Tied to Electron: the command line, the process events and the settings store.
import { join } from 'node:path'
import { app } from 'electron'
import { forceSettingsFile, readSettingBeforeReady } from '../settings/settings-file.js'
import type { SettingsStore } from '../settings/settings-store.js'
import { GUARD_FILE, readGuardRecord, writeGuardRecord } from './guard-file.js'
import { NO_GUARD_RECORD, SOFTWARE_CHECK_MS, applyX11Vulkan, offersX11Setting, planStart, revertAfterEnd, revertAfterStatus, runsOnX11, sameGuardRecord, turnedOn, windowShown } from './x11-vulkan.js'
import type { DisplayServer, GuardRecord, Revert, X11Reading } from './x11-vulkan.js'

export const X11_SETTING = 'graphics.webgpuOnX11'

interface Run {
  readonly file: string
  readonly offered: boolean
  readonly applied: boolean
  record: GuardRecord
  settings: Pick<SettingsStore, 'set' | 'onChange'> | undefined
  /** The graphics process ended badly before the settings store existed. */
  turnOffWhenStored: boolean
  publish: () => void
}

let run: Run | undefined
let quitting = false

function currentDisplay (): DisplayServer {
  return { platform: process.platform, ozoneSwitch: app.commandLine.getSwitchValue('ozone-platform'), sessionType: process.env['XDG_SESSION_TYPE'] ?? '' }
}

function keep (state: Run, record: GuardRecord): void {
  if (sameGuardRecord(state.record, record)) return
  state.record = record
  writeGuardRecord(state.file, record)
}

function turnOffSetting (state: Run): void {
  if (state.settings === undefined) { state.turnOffWhenStored = true; return }
  const result = state.settings.set(X11_SETTING, false)
  if (!result.ok) console.error('[graphics] the WebGPU-on-X11 setting could not be turned off:', result.reason)
}

/** The first revert of a run wins: it is the one that explains the rest. */
function revertRun (state: Run, revert: Revert | undefined): void {
  if (revert === undefined || state.record.revert !== null) return
  keep(state, { ...state.record, revert })
  turnOffSetting(state)
  state.publish()
}

function onChildEnd (state: Run, processType: string, reason: string): void {
  revertRun(state, revertAfterEnd({ applied: state.applied, processType, reason, quitting, now: new Date() }))
}

function checkCompositing (state: Run): void {
  const { gpu_compositing: compositing } = app.getGPUFeatureStatus()
  revertRun(state, revertAfterStatus({ applied: state.applied, compositing, now: new Date() }))
}

/**
 * First thing in `boot()`, before Chromium reads its switches: decides from the saved setting and the last run's record
 * whether this run draws through Vulkan, and sets the switches when it does. Never throws into the start of the browser.
 */
export function startX11Vulkan (dir: string): void {
  try {
    const display = currentDisplay()
    const settingsFile = join(dir, 'settings.json')
    const file = join(dir, GUARD_FILE)
    const onX11 = runsOnX11(display)
    const before = onX11 ? readGuardRecord(file) : NO_GUARD_RECORD
    const plan = planStart({ onX11, setting: onX11 && readSettingBeforeReady(settingsFile, X11_SETTING), record: before, now: new Date() })
    if (plan.turnOff) {
      try {
        forceSettingsFile(settingsFile, new Map([[X11_SETTING, false]]))
      } catch (error) {
        console.error('[graphics] the WebGPU-on-X11 setting could not be turned off:', error)
      }
    }
    const state: Run = { file, offered: offersX11Setting(display), applied: plan.applySwitches, record: before, settings: undefined, turnOffWhenStored: false, publish: () => {} }
    if (onX11) keep(state, plan.record)
    run = state
    if (!plan.applySwitches) return
    applyX11Vulkan(app.commandLine)
    app.on('before-quit', () => { quitting = true })
    app.on('child-process-gone', (_event, details) => { onChildEnd(state, details.type, details.reason) })
  } catch (error) {
    console.error('[graphics] the WebGPU-on-X11 setting could not start:', error)
  }
}

/** Once the settings store and the pages exist: a revert that came early is applied, and turning the setting on again forgets the last one. */
export function attachX11Vulkan (settings: Pick<SettingsStore, 'set' | 'onChange'>, publish: () => void): void {
  const state = run
  if (state === undefined) return
  state.settings = settings
  state.publish = publish
  if (state.turnOffWhenStored) { state.turnOffWhenStored = false; turnOffSetting(state) }
  settings.onChange(({ key, value }) => {
    if (key !== X11_SETTING || value !== true) return
    keep(state, turnedOn(state.record))
    state.publish()
  })
}

/** The launch's first window was shown: the run got as far as the guard asks, and a little later the guard looks at how pages are drawn. */
export function x11VulkanWindowShown (): void {
  const state = run
  if (state === undefined || !state.applied) return
  keep(state, windowShown(state.record))
  setTimeout(() => { try { checkCompositing(state) } catch (error) { console.error('[graphics] the WebGPU-on-X11 guard could not read the graphics status:', error) } }, SOFTWARE_CHECK_MS).unref()
}

/** What this run did, for a report and `orivon://gpu`. */
export function x11VulkanReading (): X11Reading {
  return { onAtStart: run?.applied ?? false, revert: run?.record.revert ?? null }
}

/** What Settings needs: whether to offer the choice, and the last revert. */
export function x11VulkanOffer (): { readonly offered: boolean, readonly revert: Revert | null } {
  return { offered: run?.offered ?? false, revert: run?.record.revert ?? null }
}
