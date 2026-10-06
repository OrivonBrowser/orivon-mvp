import { describe, expect, it, vi } from 'vitest'
import { fold, type AccountingState, type TelemetryEvent } from '../accounting.js'
import type { ConsentState, SentPayload } from '../disclosure.js'
import { initialHistoryState } from '../history.js'
import type { Sender } from '../transport.js'
import { initialKindState, runSendCycle, withdrawn, type SendContext, type SendCycleState } from '../engine.js'

const SEC = 1000
const september = Date.UTC(2026, 8, 1)
const october = Date.UTC(2026, 9, 1)
const INSTALL = 'ab'.repeat(16)

function browsingSince (start: number, seconds: number): AccountingState {
  const events: TelemetryEvent[] = [
    { kind: 'session-start', atMs: start, app: 'shell' },
    { kind: 'focus', atMs: start, app: 'shell' },
    { kind: 'site', atMs: start, site: 'web3:vitalik.eth' },
    { kind: 'interaction', atMs: start },
    { kind: 'interaction', atMs: start + (seconds / 2) * SEC },
    { kind: 'checkpoint', atMs: start + seconds * SEC }
  ]
  return fold(events)
}

function stateWith (accounting: AccountingState): SendCycleState {
  return { accounting, history: initialHistoryState, usage: initialKindState, sites: initialKindState }
}

function context (consent: ConsentState, installId = vi.fn(async () => INSTALL)): SendContext & { installId: ReturnType<typeof vi.fn> } {
  return { consent, version: '0.1.0', region: 'EU', stream: 'cd'.repeat(16), installId, reportIdFor: () => 'ef'.repeat(16), random: () => 0 }
}

function recordingSender (ok = true): { sender: Sender, sent: SentPayload[] } {
  const sent: SentPayload[] = []
  return { sender: async (payload) => { sent.push(payload); return ok }, sent }
}

describe('runSendCycle', () => {
  const now = (): number => september + 600 * SEC

  it('sends the month-to-date usage and sites reports once consent is accepted', async () => {
    const { sender, sent } = recordingSender()
    const result = await runSendCycle(stateWith(browsingSince(september, 500)), context('accepted'), sender, now)

    expect(sent.map((payload) => 'reportId' in payload ? 'sites' : 'usage')).toEqual(['usage', 'sites'])
    expect(sent[0]).toMatchObject({ schema: 2, installId: INSTALL, period: '2026-09', activeSec: 500, classes: { web3: 500 } })
    expect(sent[1]).toMatchObject({ schema: 2, reportId: 'ef'.repeat(16), sites: { 'web3:vitalik.eth': 500 } })
    expect(result.state.history.entries.map((entry) => entry.payload)).toEqual(sent)
    expect(result.state.usage.transport.queue).toHaveLength(0)
  })

  it('does not read the machine or call the sender while consent is undecided or declined', async () => {
    for (const consent of ['undecided', 'declined'] as const) {
      const { sender, sent } = recordingSender()
      const ctx = context(consent)
      const result = await runSendCycle(stateWith(browsingSince(september, 500)), ctx, sender, now)
      expect(sent).toHaveLength(0)
      expect(ctx.installId).not.toHaveBeenCalled()
      expect(result.state.history.entries).toHaveLength(0)
    }
  })

  it('sends the usage report again only after 24 hours, and the sites report on its own schedule', async () => {
    const { sender, sent } = recordingSender()
    const accounting = browsingSince(september, 500)
    let at = september + 600 * SEC
    const clock = (): number => at
    const first = await runSendCycle(stateWith(accounting), context('accepted'), sender, clock)
    expect(sent).toHaveLength(2)

    at += 3600 * SEC
    const second = await runSendCycle(first.state, context('accepted'), sender, clock)
    expect(sent).toHaveLength(2)

    at += 24 * 3600 * SEC
    await runSendCycle(second.state, context('accepted'), sender, clock)
    expect(sent).toHaveLength(4)
  })

  it('sends the closing snapshot of the month that ended before the new month first, once', async () => {
    const { sender, sent } = recordingSender()
    const accounting = browsingSince(september, 2000)
    let at = september + 20 * 24 * 3600 * SEC
    const clock = (): number => at
    const inSeptember = await runSendCycle(stateWith(accounting), context('accepted'), sender, clock)
    sent.length = 0

    at = october + 60 * SEC
    const inOctober = await runSendCycle(inSeptember.state, context('accepted'), sender, clock)
    const usage = sent.filter((payload) => !('reportId' in payload))
    expect(usage.map((payload) => payload.period)).toEqual(['2026-09', '2026-10'])
    sent.length = 0

    at += 25 * 3600 * SEC
    await runSendCycle(inOctober.state, context('accepted'), sender, clock)
    expect(sent.filter((payload) => !('reportId' in payload)).map((payload) => payload.period)).toEqual(['2026-10'])
  })

  it('sends no sites report when no Web3 or Web2.5 site was counted', async () => {
    const { sender, sent } = recordingSender()
    const accounting = fold([
      { kind: 'session-start', atMs: september, app: 'shell' }, { kind: 'focus', atMs: september, app: 'shell' },
      { kind: 'site', atMs: september, site: 'web2' }, { kind: 'interaction', atMs: september }, { kind: 'checkpoint', atMs: september + 100 * SEC }
    ])
    await runSendCycle(stateWith(accounting), context('accepted'), sender, now)
    expect(sent).toHaveLength(1)
    expect('reportId' in (sent[0] ?? {})).toBe(false)
  })

  it('keeps a failed report queued with backoff engaged and records nothing', async () => {
    const { sender, sent } = recordingSender(false)
    const result = await runSendCycle(stateWith(browsingSince(september, 500)), context('accepted'), sender, now)
    expect(sent).toHaveLength(2)
    expect(result.state.history.entries).toHaveLength(0)
    expect(result.state.usage.transport.queue).toHaveLength(1)
    expect(result.state.usage.transport.failureCount).toBe(1)
    expect(result.state.usage.schedule.lastSentAtMs).toBeUndefined()
  })

  it('withdrawal: the very next cycle sends nothing and empties both queues', async () => {
    const failing = recordingSender(false)
    const staged = await runSendCycle(stateWith(browsingSince(september, 500)), context('accepted'), failing.sender, now)
    expect(staged.state.usage.transport.queue).toHaveLength(1)
    expect(staged.state.sites.transport.queue).toHaveLength(1)

    const working = recordingSender()
    const after = await runSendCycle(staged.state, context('declined'), working.sender, () => now() + 24 * 3600 * SEC)
    expect(working.sent).toHaveLength(0)
    expect(after.state.usage.transport.queue).toHaveLength(0)
    expect(after.state.sites.transport.queue).toHaveLength(0)
  })

  it('a notice-version change voids consent mid-flight the same way: what was staged does not go', async () => {
    const failing = recordingSender(false)
    const staged = await runSendCycle(stateWith(browsingSince(september, 500)), context('accepted'), failing.sender, now)
    const working = recordingSender()
    const after = await runSendCycle(staged.state, context('undecided'), working.sender, now)
    expect(working.sent).toHaveLength(0)
    expect(after.state.usage.transport.queue).toHaveLength(0)
  })
})

describe('withdrawn', () => {
  it('empties both queues and keeps the schedules', () => {
    const base = stateWith(fold([]))
    const queued = { ...base, usage: { ...base.usage, schedule: { ...base.usage.schedule, offsetMs: 7 }, transport: { ...base.usage.transport, failureCount: 3 } } }
    const result = withdrawn(queued)
    expect(result.usage.transport.failureCount).toBe(0)
    expect(result.usage.schedule.offsetMs).toBe(7)
  })
})
