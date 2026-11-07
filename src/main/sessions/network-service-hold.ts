// The process's one network-service hold, kept apart from the Electron wiring (network-service-runner.ts) so a request on a
// session the runner cannot put a handler on (an embedded page's) can wait on it without importing Electron.
import { NetworkServiceRestart } from './network-service-restart.js'
import type { HoldReport } from './network-service-restart.js'
import { holdBoundOverrideMs } from './network-service-test-seam.js'

/** The longest a request waits for the settings to come back: far above a restart's own time, so only a service that never answers reaches it. */
export const HOLD_BOUND_MS = 5_000

let whenEnded: (report: HoldReport) => void = () => {}

export const networkServiceRestart = new NetworkServiceRestart({
  now: Date.now,
  boundMs: holdBoundOverrideMs() ?? HOLD_BOUND_MS,
  ended: (report) => { whenEnded(report) }
})

/** What to do when a hold ends, one way or the other; the runner sets it once. */
export function onHoldEnded (listener: (report: HoldReport) => void): void {
  whenEnded = listener
}

/** Resolves at once, or when the network service's settings are back (or the bound passes): for a request on a session the runner cannot put a handler on. */
export async function holdWhileNetworkServiceRestarts (): Promise<void> {
  await networkServiceRestart.whenOpen()
}
