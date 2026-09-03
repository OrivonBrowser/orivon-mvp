// Acceptance test for the brief's crash-recovery requirement: driving
// accounting.ts's fold with a periodic checkpoint write means an abnormal
// termination loses at most one checkpoint interval of activeSec, never
// the whole session. This exercises store.ts + accounting.ts together the
// same way runner.ts's real timer loop will -- apply events, checkpoint,
// persist; apply more events; "crash" (never persist again); reload and
// check what survived.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyEvent, totalsFor, type AccountingState, type TelemetryEvent } from './accounting.js'
import { CHECKPOINT_INTERVAL_MS } from './schedule.js'
import { TelemetryStore } from './store.js'

const SHELL_APP_ID = 'shell'
const nextFixedId = (): string => 'install-fixed'

describe('checkpoint-bounded crash recovery', () => {
  let dir: string
  let filePath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orivon-telemetry-crash-'))
    filePath = join(dir, 'telemetry.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('loses at most one checkpoint interval of activeSec, not the whole session', async () => {
    const store = new TelemetryStore(filePath, nextFixedId)
    await store.load()

    const t0 = Date.UTC(2026, 8, 1, 0, 0, 0)
    let accounting: AccountingState = store.getAccountingState()

    const apply = (event: TelemetryEvent): void => {
      accounting = applyEvent(accounting, event)
      store.setAccountingState(accounting)
    }

    // Real usage: focused and interacting from the start.
    apply({ kind: 'session-start', atMs: t0, app: SHELL_APP_ID })
    apply({ kind: 'focus', atMs: t0, app: SHELL_APP_ID })
    apply({ kind: 'interaction', atMs: t0 })

    // First checkpoint tick, at t0 + CHECKPOINT_INTERVAL_MS -- this is the
    // one that actually reaches disk.
    const firstCheckpointAt = t0 + CHECKPOINT_INTERVAL_MS
    apply({ kind: 'interaction', atMs: firstCheckpointAt }) // still active
    apply({ kind: 'checkpoint', atMs: firstCheckpointAt })
    await store.checkpoint()

    // More real activity happens, into the SECOND interval, but the
    // process dies partway through it -- no second checkpoint()/persist
    // ever runs. 45s in: bounded by, and less than, CHECKPOINT_INTERVAL_MS.
    const crashOffsetMs = 45_000
    expect(crashOffsetMs).toBeLessThan(CHECKPOINT_INTERVAL_MS)
    const crashAt = firstCheckpointAt + crashOffsetMs
    apply({ kind: 'interaction', atMs: crashAt })
    apply({ kind: 'checkpoint', atMs: crashAt }) // settles in memory; never persisted -- this is the "crash"

    const trueActiveSec = totalsFor(accounting, SHELL_APP_ID, '2026-09').activeSec
    expect(trueActiveSec).toBeCloseTo((CHECKPOINT_INTERVAL_MS + crashOffsetMs) / 1000, 5)

    // Reload as a fresh process would after the crash.
    const recovered = new TelemetryStore(filePath, nextFixedId)
    await recovered.load()
    const recoveredActiveSec = totalsFor(recovered.getAccountingState(), SHELL_APP_ID, '2026-09').activeSec

    // Exactly what the last real checkpoint captured -- the first interval only.
    expect(recoveredActiveSec).toBeCloseTo(CHECKPOINT_INTERVAL_MS / 1000, 5)

    // The loss is bounded: less than the whole session's true activeSec,
    // and no more than one checkpoint interval's worth.
    const lostSec = trueActiveSec - recoveredActiveSec
    expect(lostSec).toBeCloseTo(crashOffsetMs / 1000, 5)
    expect(lostSec).toBeLessThan(CHECKPOINT_INTERVAL_MS / 1000)
    expect(lostSec).toBeLessThan(trueActiveSec) // never the whole session
  })
})
