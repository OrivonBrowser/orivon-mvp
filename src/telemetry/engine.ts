// Composes accounting, disclosure, transport, schedule and history into the one send cycle the runner's
// timer drives. Pure aside from the injected Sender, clock and ID sources, so the rule it exists to
// protect, that nothing is staged or transmitted unless consent is live AT THIS CALL, is provable
// without a network or an Electron process. The runner re-reads consent on every tick and passes it
// in; nothing here could cache a previous call's answer.
import { SHELL_APP_ID, periodOf, type AccountingState } from './accounting.js'
import {
  buildSitesPayload, buildUsagePayload, hasSites, mayTransmit,
  type ConsentState, type PayloadKind, type SentPayload
} from './disclosure.js'
import { recordSent, type HistoryState } from './history.js'
import type { Region } from './region.js'
import { afterSent, initialKindSchedule, periodsDue, withOffsetFor, type KindSchedule } from './schedule.js'
import { attemptSend, enqueue, initialTransportState, type Clock, type Sender, type TransportState } from './transport.js'

/** One kind of report: what waits to go, and when it last went. */
export interface KindState {
  readonly transport: TransportState
  readonly schedule: KindSchedule
}

export const initialKindState: KindState = { transport: initialTransportState, schedule: initialKindSchedule }

export interface SendCycleState {
  readonly accounting: AccountingState
  readonly history: HistoryState
  readonly usage: KindState
  readonly sites: KindState
}

export interface SendContext {
  readonly consent: ConsentState
  readonly version: string
  readonly region: Region
  /** This profile's random stream. */
  readonly stream: string
  /** Called only once consent is live: reading the machine is not allowed before then. */
  readonly installId: () => Promise<string>
  /** The random report ID of a period's sites report, the same one every time that period is asked. */
  readonly reportIdFor: (period: string) => string
  readonly random?: () => number
  /** The width a period's random offset is drawn from; a test build may narrow it to nothing. */
  readonly offsetWindowMs?: number
}

export interface SendCycleResult {
  readonly state: SendCycleState
  /** Every payload that actually went this call. */
  readonly sent: readonly SentPayload[]
}

const KINDS: readonly PayloadKind[] = ['usage', 'sites']

/** Clears everything staged, both kinds: what withdrawal does at once. The schedule stays, so a later acceptance does not re-draw offsets for no reason. */
export function withdrawn (state: SendCycleState): SendCycleState {
  return {
    ...state,
    usage: { ...state.usage, transport: initialTransportState },
    sites: { ...state.sites, transport: initialTransportState }
  }
}

function hasUsageData (accounting: AccountingState, period: string): boolean {
  return accounting.perApp[SHELL_APP_ID]?.[period] !== undefined
}

export async function runSendCycle (state: SendCycleState, ctx: SendContext, sender: Sender, clock: Clock): Promise<SendCycleResult> {
  if (!mayTransmit(ctx.consent)) return { state: withdrawn(state), sent: [] }

  const now = clock()
  const period = periodOf(now)
  const installId = await ctx.installId()
  const sentPayloads: SentPayload[] = []
  let current = state

  for (const kind of KINDS) {
    let kindState: KindState = { ...current[kind], schedule: withOffsetFor(current[kind].schedule, period, ctx.random, ctx.offsetWindowMs) }
    const payloadFor = (target: string): SentPayload => kind === 'usage'
      ? buildUsagePayload(current.accounting, { installId, stream: ctx.stream, region: ctx.region, version: ctx.version, period: target })
      : buildSitesPayload(current.accounting, { reportId: ctx.reportIdFor(target), version: ctx.version, period: target })
    const hasData = (target: string): boolean => kind === 'usage'
      ? hasUsageData(current.accounting, target)
      : hasSites(buildSitesPayload(current.accounting, { reportId: '', version: ctx.version, period: target }))

    let transport = kindState.transport
    for (const due of periodsDue(now, period, kindState.schedule, hasData)) {
      if (due === period && !hasData(due) && kind === 'sites') continue
      transport = enqueue(transport, payloadFor(due), ctx.consent, clock)
    }

    let history = current.history
    for (;;) {
      const result = await attemptSend(transport, ctx.consent, sender, clock)
      transport = result.state
      if (result.sent === undefined) break
      history = recordSent(history, { payload: result.sent.payload, sentAtMs: result.sent.sentAtMs })
      kindState = { ...kindState, schedule: afterSent(kindState.schedule, result.sent.payload.period, result.sent.enqueuedAtMs, result.sent.sentAtMs) }
      sentPayloads.push(result.sent.payload)
    }

    current = { ...current, history, [kind]: { transport, schedule: kindState.schedule } }
  }
  return { state: current, sent: sentPayloads }
}
