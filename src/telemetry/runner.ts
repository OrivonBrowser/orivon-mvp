// Real wiring for accounting.ts/disclosure.ts/transport.ts/history.ts via
// engine.ts/store.ts/window-focus.ts/schedule.ts: persistence, real main-
// process lifecycle events, and the real HTTP send. Split out the same way
// src/main/update-check-runner.ts splits from update-check.ts (Rule 2) --
// untested by design, same reasoning as that file's own header states:
// every decision worth getting right lives in the pure/injected functions
// this file composes, and THOSE are tested (engine.test.ts, window-
// focus.test.ts, schedule.test.ts, store.test.ts, checkpoint-recovery.test.ts).
//
// WHY THE ELECTRON IMPORT BELOW IS `import type`, AND WHY REAL ELECTRON
// VALUES (BaseWindow/powerMonitor/net) ARE IMPORTED DYNAMICALLY INSIDE THE
// FUNCTIONS THAT USE THEM: same reasoning as update-check-runner.ts's own
// header -- a top-level static value import from 'electron' is silently
// broken under this repo's vitest (the package's entry point outside a
// real Electron process is a string, not the API surface), and this file
// has no test importing it, so a dynamic import inside each function body
// is never reached at all while other tests merely import sibling files.
//
// TWO REAL DECISIONS THIS FILE MAKES THAT THE OWNER HAS NOT CONFIRMED --
// see this lane's QUESTION checkpoint (log.md) for the full reasoning:
//   1. SHELL_APP_ID below is a placeholder AppId representing the whole
//      Orivon process, standing in until a future lane gives a real
//      capability-app's identity a source (nothing in this tree connects
//      a loaded app to a tab yet).
//   2. TELEMETRY_INGEST_URL is unprovisioned -- ADR-0004 requires a
//      self-hosted ingest endpoint that does not exist yet anywhere in
//      this repository or its docs.
import type { App } from 'electron'
import { join } from 'node:path'
import type { Subsystem } from '../main/registry.js'
import { applyEvent, periodOf, type AccountingState, type TelemetryEvent } from './accounting.js'
import {
  applyDisclosureChoice,
  buildDisclosurePayload,
  DISCLOSURE_OPTIONS,
  type ConsentState,
  type DisclosureChoiceId,
  type DisclosureMeta,
  type TelemetryPayload
} from './disclosure.js'
import { runSendCycle } from './engine.js'
import type { HistoryState } from './history.js'
import {
  CHECKPOINT_INTERVAL_MS,
  IDLE_INTERACTION_THRESHOLD_SEC,
  isOffsetStale,
  pickSendOffsetMs,
  SEND_CHECK_INTERVAL_MS
} from './schedule.js'
import { initialTransportState, type Sender, type TransportState } from './transport.js'
import { TelemetryStore } from './store.js'
import { reconcileWindowFocus, type TrackedWindow } from './window-focus.js'

/** See the file header's QUESTION note. */
export const SHELL_APP_ID = 'shell'

/** See the file header's QUESTION note. RFC 2606 `.example` -- guaranteed
 *  never to resolve, so this placeholder cannot silently start receiving
 *  real user data before the owner replaces it with a real endpoint. */
export const TELEMETRY_INGEST_URL = 'https://telemetry.orivonstack.example/v1/ingest'

const FETCH_TIMEOUT_MS = 10_000

function telemetryFilePath (app: App): string {
  // ADR-0003's "Browser state" tier, same as bookmarks.json: plain JSON,
  // no safeStorage -- an install UUID and a self-declared country are not
  // secrets the way the identity seed is.
  return join(app.getPath('userData'), 'telemetry.json')
}

async function realSender (payload: TelemetryPayload): Promise<boolean> {
  const { net } = await import('electron')
  try {
    const response = await net.fetch(TELEMETRY_INGEST_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    // ADR-0004: "the client ignores the response body entirely" -- status
    // only, never parsed or read.
    return response.ok
  } catch {
    return false // offline, DNS failure, timeout -- attemptSend treats this like any other failed attempt
  }
}

const realClock = (): number => Date.now()

/** Set once startTelemetry() has loaded the real store, so the read/decide
 *  functions below (for a future disclosure/history UI) see the SAME live
 *  instance the running subsystem is checkpointing, not a stale copy. */
let runningStore: TelemetryStore | undefined

async function loadedStore (app: App): Promise<TelemetryStore> {
  if (runningStore !== undefined) return runningStore
  const store = new TelemetryStore(telemetryFilePath(app))
  await store.load()
  return store
}

async function startTelemetry (app: App): Promise<void> {
  const store = new TelemetryStore(telemetryFilePath(app))
  await store.load()
  runningStore = store

  const { BaseWindow, powerMonitor } = await import('electron')

  let accounting: AccountingState = store.getAccountingState()
  let transport: TransportState = initialTransportState
  let focusedIds: ReadonlySet<number> = new Set()
  let offsetPeriod: string | undefined
  let scheduledSendAtMs = 0

  const applyAndStore = (event: TelemetryEvent): void => {
    accounting = applyEvent(accounting, event)
    store.setAccountingState(accounting)
  }

  applyAndStore({ kind: 'session-start', atMs: realClock(), app: SHELL_APP_ID })

  // Best-effort, not guaranteed: `void` here means the process could in
  // principle exit before this write lands, the same way any other
  // between-checkpoints termination can. Not treated as a gap worth
  // blocking quit over (event.preventDefault() + a manual re-quit once
  // flushed) -- that would make an ordinary quit occasionally hang for a
  // subsystem with no UI, a worse tradeoff than accepting the same
  // bounded loss (at most one CHECKPOINT_INTERVAL_MS) an ordinary crash
  // already has.
  app.on('before-quit', () => {
    applyAndStore({ kind: 'session-stop', atMs: realClock(), app: SHELL_APP_ID })
    void store.checkpoint()
  })
  powerMonitor.on('suspend', () => { applyAndStore({ kind: 'suspend', atMs: realClock() }) })
  powerMonitor.on('resume', () => { applyAndStore({ kind: 'resume', atMs: realClock() }) })

  let checkpointInFlight = false
  async function checkpointTick (): Promise<void> {
    if (checkpointInFlight) return // a previous tick is still writing; skip rather than overlap
    checkpointInFlight = true
    try {
      const now = realClock()

      const windows: TrackedWindow[] = BaseWindow.getAllWindows().map((w) => ({ id: w.id, focused: w.isFocused() }))
      const reconciled = reconcileWindowFocus(focusedIds, windows)
      focusedIds = reconciled.nextFocusedIds
      if (reconciled.transition === 'gained-focus') applyAndStore({ kind: 'focus', atMs: now, app: SHELL_APP_ID })
      else if (reconciled.transition === 'lost-focus') applyAndStore({ kind: 'blur', atMs: now })

      // Real, OS-level input signal -- see this lane's QUESTION checkpoint
      // for why this replaces any window.ts/tabs.ts-sourced interaction
      // event (none exists).
      if (powerMonitor.getSystemIdleState(IDLE_INTERACTION_THRESHOLD_SEC) === 'active') {
        applyAndStore({ kind: 'interaction', atMs: now })
      }

      applyAndStore({ kind: 'checkpoint', atMs: now })
      await store.checkpoint()
    } finally {
      checkpointInFlight = false
    }
  }

  let sendInFlight = false
  async function sendTick (): Promise<void> {
    if (sendInFlight) return
    sendInFlight = true
    try {
      const now = realClock()
      const period = periodOf(now)

      if (isOffsetStale(offsetPeriod, period)) {
        offsetPeriod = period
        scheduledSendAtMs = now + pickSendOffsetMs()
      }
      if (now < scheduledSendAtMs) return

      const meta: DisclosureMeta = {
        installId: store.getInstallId(),
        country: store.getCountry(),
        version: app.getVersion(),
        period
      }
      const consentState: ConsentState = store.getConsentState() // read fresh, every tick -- never cached

      const result = await runSendCycle(
        { accounting: store.getAccountingState(), transport, history: store.getHistoryState() },
        meta,
        consentState,
        realSender,
        realClock
      )
      transport = result.transport
      store.setHistoryState(result.history)
      if (result.sent) await store.checkpoint()
    } finally {
      sendInFlight = false
    }
  }

  setInterval(() => { void checkpointTick() }, CHECKPOINT_INTERVAL_MS)
  setInterval(() => { void sendTick() }, SEND_CHECK_INTERVAL_MS)
}

export const telemetrySubsystem: Subsystem = {
  name: 'telemetry',
  afterReady: (ctx) => {
    // Deliberately NOT awaited -- same reasoning as updateCheckSubsystem
    // (update-check-runner.ts): runAfterReady (registry.ts) awaits every
    // subsystem in order before the shell window is created, and nothing
    // else in the app depends on telemetry's own init order. Because it is
    // detached, this subsystem must catch its own errors -- registry.ts's
    // try/catch only covers what afterReady itself returns/throws
    // synchronously.
    void startTelemetry(ctx.app).catch((error) => {
      console.error('[orivon] subsystem "telemetry" failed:', error)
    })
  }
}

// Read/decide functions for a future disclosure screen and "what has been
// sent" page (deliberately not built by this lane -- see src/telemetry/
// README.md and this lane's PR). Each falls back to loading its own copy
// of the store if the subsystem has not started yet (should not happen in
// practice, since runAfterReady always runs before any UI could call
// these, but a future UI subsystem should not have to know that).

export async function getConsentState (app: App): Promise<ConsentState> {
  return (await loadedStore(app)).getConsentState()
}

export async function decideConsent (app: App, optionId: DisclosureChoiceId): Promise<void> {
  const option = DISCLOSURE_OPTIONS.find((candidate) => candidate.id === optionId)
  if (option === undefined) throw new Error(`telemetry: unknown disclosure option id ${JSON.stringify(optionId)}`)
  await (await loadedStore(app)).setConsentState(applyDisclosureChoice(option))
}

export async function setCountry (app: App, country: string): Promise<void> {
  await (await loadedStore(app)).setCountry(country)
}

/** The literal payload ADR-0004 requires the disclosure screen to render
 *  -- "the literal JSON that would be sent", not a description of it. */
export async function previewDisclosurePayload (app: App): Promise<TelemetryPayload> {
  const store = await loadedStore(app)
  const meta: DisclosureMeta = {
    installId: store.getInstallId(),
    country: store.getCountry(),
    version: app.getVersion(),
    period: periodOf(realClock())
  }
  return buildDisclosurePayload(store.getAccountingState(), meta)
}

export async function getSentHistory (app: App): Promise<HistoryState> {
  return (await loadedStore(app)).getHistoryState()
}
