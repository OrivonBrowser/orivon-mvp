// The Electron half of a network-service restart (network-service-recovery.ts is its order, network-service-restart.ts
// the hold). When Chromium's network service ends, a web request handler is put first on every website session so no
// request reaches certificate verification or DNS, the new service is waited for, each setting registered here is sent
// to every session again, and the handlers come off. Tied to Electron: `child-process-gone`, `session-created`, the sessions.
import { app, session } from 'electron'
import type { Session } from 'electron'
import type { Subsystem } from '../registry.js'
import { NetworkServiceRecovery, holdLine, untilAnswered } from './network-service-recovery.js'
import type { Reapplier } from './network-service-recovery.js'
import { HOLD_BOUND_MS, networkServiceRestart, onHoldEnded } from './network-service-hold.js'
import { isNetworkServiceEnd } from './network-service-restart.js'
import { noteHoldEnded, noteServiceEnded, noteSettingsResent, reapplyDelayMs } from './network-service-test-seam.js'
import { webRequestOwnerFor } from './web-request-owner.js'
import type { WebRequestHandlerHandle } from './web-request-owner.js'
import { forEachWebsiteSession, websiteSessions } from './website-sessions.js'

/** Ahead of every other `onBeforeRequest` handler, so nothing of theirs runs for a request that is waiting. */
const HOLD_ORDER = Number.MIN_SAFE_INTEGER
/** The requests that reach certificate verification or DNS. */
const NETWORK_REQUESTS = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }

const reappliers: Array<Reapplier<Session>> = []
/** Every session Electron has made, the default one included: the certificate check lives on each. */
const known = new Set<Session>()
const holds = new Map<Session, WebRequestHandlerHandle>()
let quitting = false

/** Registers a setting that lives on the network service: `reapply` runs for every session each time a new service starts. */
export function reapplyAfterNetworkServiceRestart (name: string, reapply: Reapplier<Session>['reapply']): void {
  reappliers.push({ name, reapply })
}

const restart = networkServiceRestart

onHoldEnded((report) => {
  try {
    for (const handle of holds.values()) handle.remove()
  } catch (error) {
    console.error('[network-service] taking the hold off a session failed:', error)
  } finally {
    holds.clear()
  }
  if (report.outcome === 'timed-out') console.error(holdLine(report))
  else console.log(holdLine(report))
  noteHoldEnded(report)
})

function hold (target: Session): void {
  if (holds.has(target)) return
  holds.set(target, webRequestOwnerFor(target).onBeforeRequest(HOLD_ORDER, NETWORK_REQUESTS, () => true, async (_details, current) => {
    await restart.whenOpen()
    return current
  }))
}

/** An address literal: needs no DNS, so what answers it is the session's network context and nothing else. */
const PROBE_ADDRESS = '127.0.0.1'

/** Once the default session answers, how long the others are given: a session nobody uses may be slow to answer, and must not delay the rest. */
const OTHERS_GRACE_MS = 1_000

const pause = async (ms: number): Promise<void> => await new Promise<void>((resolve) => { setTimeout(resolve, ms) })

/**
 * Resolves once the default session's new network context answers a call and the other sessions have had a moment to; a
 * test build may then wait on, so a request can be started inside the hold. Rejects when the default session never answers.
 */
async function networkServiceAnswers (targets: readonly Session[]): Promise<void> {
  let done = false
  const asked = targets.map(async (target) => await untilAnswered(async () => await target.resolveHost(PROBE_ADDRESS), { boundMs: HOLD_BOUND_MS, stop: () => done }))
  for (const one of asked) one.catch(() => {})
  try {
    await asked[Math.max(0, targets.indexOf(session.defaultSession))]
    await Promise.race([Promise.allSettled(asked), pause(OTHERS_GRACE_MS)])
  } finally {
    done = true
  }
  const wait = reapplyDelayMs()
  if (wait > 0) await pause(wait)
}

const recovery = new NetworkServiceRecovery<Session>({
  restart,
  ready: networkServiceAnswers,
  targets: () => [...known],
  reappliers: () => reappliers,
  now: Date.now,
  log: (line) => { console.log(line) },
  holdBegan: () => {
    for (const target of websiteSessions()) {
      try {
        hold(target)
      } catch (error) {
        console.error('[network-service] could not hold requests of a session:', error)
      }
    }
  }
})

export const networkServiceSubsystem: Subsystem = {
  name: 'network-service',
  beforeReady: () => {
    app.on('session-created', (created) => { known.add(created) })
    app.on('before-quit', () => { quitting = true })
    app.on('child-process-gone', (_event, details) => {
      if (quitting || !isNetworkServiceEnd(details)) return
      noteServiceEnded()
      recovery.onEnded({ reason: details.reason, exitCode: details.exitCode }).then((sent) => { if (sent) noteSettingsResent() }, (error: unknown) => {
        console.error('[network-service] sending the settings again failed:', error)
      })
    })
  },
  afterReady: () => {
    known.add(session.defaultSession)
    // A website session announced while requests are waiting gets the same handler.
    forEachWebsiteSession((target) => { if (restart.isHolding()) hold(target) })
  }
}
