// The Electron wiring of telemetry: the timers, the real windows and power events, the real network,
// and the functions the Settings page and the welcome screen call. Every decision lives in the pure
// and injected modules this file composes (service.ts and what it uses), and those are tested.
//
// WHY THE ELECTRON IMPORT BELOW IS `import type`, AND WHY REAL ELECTRON VALUES (BaseWindow/powerMonitor/net)
// ARE IMPORTED DYNAMICALLY INSIDE THE FUNCTIONS THAT USE THEM: a top-level static value import from
// 'electron' is silently broken under the unit tests (outside a real Electron process the package's
// entry point is a string, not the API surface).
//
// Telemetry never starts under ORIVON_TELEMETRY=off or in a private session: then nothing is counted, no
// machine identifier is read and nothing is sent. Under `npm run dev` it runs, but sends to an address
// that cannot answer (mode.ts).
import type { App } from 'electron'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Subsystem } from '../main/registry.js'
import { devModeEnabled } from '../main/dev/dev-mode.js'
import type { SiteKey } from './accounting.js'
import type { ConsentSource } from './consent.js'
import type { ErasePayload, SentPayload } from './disclosure.js'
import type { MachineIdReaders } from './install-id.js'
import {
  IS_TEST_BUILD, endpointUrl, ingestBaseUrl, modeInputsFromEnv, telemetryHome, telemetryOffReason, testOverrides,
  type Endpoint, type OffReason
} from './mode.js'
import { countryOfTimeZone, systemTimeZone } from './country.js'
import { CHECKPOINT_INTERVAL_MS, IDLE_INTERACTION_THRESHOLD_SEC, SEND_CHECK_INTERVAL_MS } from './schedule.js'
import { TelemetryService, type TelemetryStatus } from './service.js'
import { TelemetryStore } from './store.js'
import { SystemStore } from './system-store.js'
import type { TrackedWindow } from './window-focus.js'

const FETCH_TIMEOUT_MS = 10_000
const MACHINE_ID_TIMEOUT_MS = 3_000
const START_SEND_DELAY_MS = 10_000

async function post (endpoint: Endpoint, body: SentPayload | ErasePayload): Promise<boolean> {
  const { net } = await import('electron')
  const base = ingestBaseUrl(IS_TEST_BUILD, testOverrides().url, modeInputsFromEnv(process.env, devModeEnabled(), false).development)
  try {
    const response = await net.fetch(endpointUrl(base, endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    // The server answers every success with an empty 204; the status is all that is read.
    return response.ok
  } catch {
    return false // offline, DNS failure, timeout: a failed attempt like any other
  }
}

const realSender = async (payload: SentPayload): Promise<boolean> => await post('sites' in payload ? 'sites' : 'usage', payload)

const realMachineReaders: MachineIdReaders = {
  platform: process.platform,
  systemRoot: process.env['SystemRoot'],
  readFile: async (path) => {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return undefined
    }
  },
  run: async (file, args) => await new Promise((resolve) => {
    execFile(file, [...args], { timeout: MACHINE_ID_TIMEOUT_MS, windowsHide: true }, (error, stdout) => { resolve(error === null ? stdout : undefined) })
  })
}

interface Configured {
  readonly offReason: OffReason | undefined
  readonly service: Promise<TelemetryService> | undefined
}

let configured: Configured | undefined

const changeListeners = new Set<() => void>()

function notifyChanged (): void {
  for (const listener of changeListeners) listener()
}

/** Returns the unsubscribe. Fires when a send happened or the choice changed, for the Settings page. */
export function onTelemetryChanged (listener: () => void): () => void {
  changeListeners.add(listener)
  return () => { changeListeners.delete(listener) }
}

async function buildService (app: App): Promise<TelemetryService> {
  const overrides = testOverrides()
  const home = telemetryHome({
    testBuild: IS_TEST_BUILD,
    overrideHome: overrides.home,
    development: devModeEnabled(),
    userData: app.getPath('userData'),
    appData: app.getPath('appData')
  })
  const store = new TelemetryStore(join(app.getPath('userData'), 'telemetry.json'))
  await store.load()
  return new TelemetryService({
    store,
    system: new SystemStore(home),
    version: app.getVersion(),
    country: () => countryOfTimeZone(systemTimeZone()),
    machineReaders: realMachineReaders,
    randomId: () => randomBytes(16).toString('hex'),
    clock: () => Date.now(),
    send: realSender,
    sendErase: async (payload) => await post('erase', payload),
    ...(overrides.tickMs === undefined ? {} : { offsetWindowMs: 0, snapshotEveryMs: overrides.tickMs * 2 }),
    notify: notifyChanged
  })
}

async function startTelemetry (app: App, servicePromise: Promise<TelemetryService>): Promise<void> {
  const service = await servicePromise
  const { BaseWindow, powerMonitor } = await import('electron')
  const { tickMs, assumeActive } = testOverrides()

  const windows = (): TrackedWindow[] => assumeActive ? [{ id: 0, focused: true }] : BaseWindow.getAllWindows().map((w) => ({ id: w.id, focused: w.isFocused() }))
  // Real, OS-level input signal, chosen because no window or tab event exists to feed here instead.
  const interacting = (): boolean => assumeActive || powerMonitor.getSystemIdleState(IDLE_INTERACTION_THRESHOLD_SEC) === 'active'

  powerMonitor.on('suspend', () => { service.notePower('suspend') })
  powerMonitor.on('resume', () => { service.notePower('resume') })

  let checkpointing = false
  const checkpointTick = async (): Promise<void> => {
    if (checkpointing) return
    checkpointing = true
    try {
      await service.checkpointTick(windows(), interacting())
    } catch (error) {
      console.error('[orivon] telemetry checkpoint failed:', error)
    } finally {
      checkpointing = false
    }
  }
  const sendTick = async (): Promise<void> => {
    try {
      await service.sendTick()
    } catch (error) {
      console.error('[orivon] telemetry send failed:', error)
    }
  }
  setInterval(() => { void checkpointTick() }, tickMs ?? CHECKPOINT_INTERVAL_MS)
  setInterval(() => { void sendTick() }, tickMs ?? SEND_CHECK_INTERVAL_MS)
  const sendAtStart = async (): Promise<void> => {
    try {
      await service.sendNow()
    } catch (error) {
      console.error('[orivon] telemetry send failed:', error)
    }
  }
  // Both reports go once at start, past the random offset and the daily gate; the server keeps the newest
  // of a month's reports. Delayed because this runs before the first window exists, and the first send
  // reads the machine identifier and the country. A quit inside the delay still sends. A test tick
  // shortens the delay, never lengthens it.
  void checkpointTick().then(() => { setTimeout(() => { void sendAtStart() }, Math.min(tickMs ?? START_SEND_DELAY_MS, START_SEND_DELAY_MS)) })
}

export const telemetrySubsystem: Subsystem = {
  name: 'telemetry',
  beforeQuit: async () => { await (await running())?.quit() },
  afterReady: (ctx) => {
    const offReason = telemetryOffReason(modeInputsFromEnv(process.env, devModeEnabled(), ctx.privateSession))
    if (offReason !== undefined) {
      configured = { offReason, service: undefined }
      return
    }
    // Deliberately NOT awaited, as updateCheckSubsystem: runAfterReady awaits every subsystem in order
    // before the shell window is created. Detached, it must catch its own errors.
    const service = buildService(ctx.app)
    configured = { offReason: undefined, service }
    void startTelemetry(ctx.app, service).catch((error) => {
      console.error('[orivon] subsystem "telemetry" failed:', error)
    })
  }
}

/** Why telemetry does not run in this process, or undefined when it does. */
export function telemetryOff (): OffReason | undefined {
  return configured?.offReason
}

async function running (): Promise<TelemetryService | undefined> {
  return await configured?.service
}

/** The site now in front, from the shell's tab events. Nothing happens when telemetry does not run. */
export function noteSite (site: SiteKey): void {
  void running().then((service) => { service?.noteSite(site) })
}

export type StatusReply = { readonly off: OffReason } | { readonly off: undefined, readonly status: TelemetryStatus }

export async function getTelemetryStatus (): Promise<StatusReply> {
  const service = await running()
  if (service === undefined) return { off: configured?.offReason ?? 'env' }
  return { off: undefined, status: await service.status() }
}

export async function setTelemetryOn (on: boolean, source: ConsentSource): Promise<boolean> {
  const service = await running()
  if (service === undefined) return false
  await service.setOn(on, source)
  return true
}

/** Whether the welcome screen puts the telemetry question: it runs here, and the person has not chosen. */
export async function welcomeOffersTelemetry (): Promise<boolean> {
  const service = await running()
  return service === undefined ? false : await service.offerAtWelcome()
}

/** The change lines when the person's earlier acceptance is due to be asked again at this start, else undefined (also when telemetry does not run here). */
export async function telemetryRenewal (): Promise<readonly string[] | undefined> {
  const service = await running()
  return service === undefined ? undefined : await service.renewalAtStart()
}

/** 'done' when the server confirmed, 'failed' when it did not, 'nothing' when nothing was ever sent from this computer. */
export async function eraseTelemetry (): Promise<'nothing' | 'done' | 'failed'> {
  const service = await running()
  return service === undefined ? 'failed' : await service.erase()
}
