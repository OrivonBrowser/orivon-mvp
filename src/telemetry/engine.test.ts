import { describe, expect, it } from 'vitest'
import { fold, type TelemetryEvent } from './accounting.js'
import type { DisclosureMeta } from './disclosure.js'
import { initialHistoryState } from './history.js'
import { initialTransportState, type Sender } from './transport.js'
import { runSendCycle, type SendCycleState } from './engine.js'

const meta: DisclosureMeta = {
  installId: '4c2f2f3a-1111-4444-8888-abcde1234567',
  country: 'IT',
  version: '0.1.0',
  period: '2026-09'
}

const t0 = Date.UTC(2026, 8, 1, 0, 0, 0)

function sessionState (): SendCycleState {
  const events: TelemetryEvent[] = [
    { kind: 'session-start', atMs: t0, app: 'shell' },
    { kind: 'focus', atMs: t0, app: 'shell' },
    { kind: 'interaction', atMs: t0 },
    { kind: 'checkpoint', atMs: t0 + 60_000 }
  ]
  return { accounting: fold(events), transport: initialTransportState, history: initialHistoryState }
}

function countingSender (result: boolean): { sender: Sender; calls: number[] } {
  const calls: number[] = []
  const sender: Sender = async (payload) => {
    calls.push(1)
    void payload
    return result
  }
  // Mutating a shared array via closure so the test can read call count
  // after the fact without a second layer of mocking.
  return { sender, calls }
}

describe('runSendCycle', () => {
  it('builds the payload, sends it, and records it in history when consent is accepted', async () => {
    const state = sessionState()
    const { sender, calls } = countingSender(true)
    const clock = (): number => t0 + 120_000

    const result = await runSendCycle(state, meta, 'accepted', sender, clock)

    expect(calls).toHaveLength(1)
    expect(result.sent).toBe(true)
    expect(result.history.entries).toHaveLength(1)
    expect(result.history.entries[0]?.payload.period).toBe('2026-09')
    expect(result.transport.queue).toHaveLength(0) // sent successfully -- drained
  })

  it('never calls the sender when consent is undecided', async () => {
    const state = sessionState()
    const { sender, calls } = countingSender(true)
    const clock = (): number => t0 + 120_000

    const result = await runSendCycle(state, meta, 'undecided', sender, clock)

    expect(calls).toHaveLength(0)
    expect(result.sent).toBe(false)
    expect(result.history.entries).toHaveLength(0)
  })

  it('never calls the sender when consent is declined, even with real accrued activity', async () => {
    const state = sessionState()
    const { sender, calls } = countingSender(true)
    const clock = (): number => t0 + 120_000

    const result = await runSendCycle(state, meta, 'declined', sender, clock)

    expect(calls).toHaveLength(0)
    expect(result.sent).toBe(false)
  })

  // Acceptance criterion: consent revoked mid-session must stop the very
  // next scheduled send, not the one after -- transport.ts's own rule
  // (mayTransmit consulted on every call, never cached), exercised here
  // through the actual composition this lane wires together.
  it('consent revoked mid-session: the next scheduled send does not fire', async () => {
    const state = sessionState()
    const { sender, calls } = countingSender(true)
    let now = t0 + 120_000
    const clock = (): number => now

    // First cycle: user has accepted, a send goes out for the current period.
    const first = await runSendCycle(state, meta, 'accepted', sender, clock)
    expect(calls).toHaveLength(1)
    expect(first.sent).toBe(true)

    // More activity accrues, and the user revokes consent before the next
    // scheduled cycle runs.
    const moreEvents: TelemetryEvent[] = [
      { kind: 'interaction', atMs: now },
      { kind: 'checkpoint', atMs: now + 60_000 }
    ]
    now += 60_000
    const accruedAccounting = fold(moreEvents, state.accounting)
    const nextState: SendCycleState = { accounting: accruedAccounting, transport: first.transport, history: first.history }

    const second = await runSendCycle(nextState, meta, 'declined', sender, clock)

    // The sender must NOT have been called a second time.
    expect(calls).toHaveLength(1)
    expect(second.sent).toBe(false)
    // Declining purges the backlog outright (transport.ts's onConsentWithdrawn) --
    // nothing is left staged to leak out the moment consent is re-enabled.
    expect(second.transport.queue).toHaveLength(0)
  })

  it('a failed send leaves the payload queued with backoff engaged, and records nothing in history', async () => {
    const state = sessionState()
    const { sender, calls } = countingSender(false)
    const clock = (): number => t0 + 120_000

    const result = await runSendCycle(state, meta, 'accepted', sender, clock)

    expect(calls).toHaveLength(1)
    expect(result.sent).toBe(false)
    expect(result.history.entries).toHaveLength(0)
    expect(result.transport.queue).toHaveLength(1)
    expect(result.transport.failureCount).toBe(1)
  })
})
