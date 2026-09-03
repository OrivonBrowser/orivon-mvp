// Composes accounting.ts, disclosure.ts, transport.ts and history.ts into
// the one send cycle runner.ts's timer drives -- pure aside from the
// injected Sender/Clock, exactly transport.test.ts's own testing idiom
// (a fake Sender and Clock, exact assertions on the returned state), so
// the rule this whole lane exists to protect -- nothing transmits without
// disclosure.ts reporting live consent AT THIS CALL, never a cached
// boot-time flag -- is provable without a real network or a real Electron
// process.
//
// runner.ts is the only caller, and it is what makes "live": it re-reads
// the store's current ConsentState fresh on every timer tick and passes
// that value in here as `consentState`. This function itself has no
// memory of a previous call's consent -- there is nothing here THAT COULD
// cache it, which is what makes "never cached" true by construction
// rather than by discipline at the call site (the same shape transport.ts
// itself uses for attemptSend).
import { buildDisclosurePayload, type ConsentState, type DisclosureMeta } from './disclosure.js'
import { recordSent, type HistoryState } from './history.js'
import type { AccountingState } from './accounting.js'
import { attemptSend, enqueue, type Clock, type Sender, type TransportState } from './transport.js'

export interface SendCycleState {
  readonly accounting: AccountingState
  readonly transport: TransportState
  readonly history: HistoryState
}

export interface SendCycleResult {
  readonly transport: TransportState
  readonly history: HistoryState
  /** True only on an actual successful send this call -- mirrors
   *  SendResult.sent's own "undefined for every other outcome" contract,
   *  collapsed to a boolean since callers here don't need the payload back. */
  readonly sent: boolean
}

/**
 * One send attempt for `meta.period`: builds the literal payload from the
 * current accounting totals, stages it (enqueue refuses outright unless
 * `consentState` is 'accepted' -- see transport.ts), then attempts to send
 * the queue's head (attemptSend checks consent again, first, before
 * anything else). A successful send is appended to history; every other
 * outcome (refused, backing off, failed) leaves history untouched.
 */
export async function runSendCycle (
  state: SendCycleState,
  meta: DisclosureMeta,
  consentState: ConsentState,
  sender: Sender,
  clock: Clock
): Promise<SendCycleResult> {
  const payload = buildDisclosurePayload(state.accounting, meta)
  const queued = enqueue(state.transport, payload, consentState, clock)
  const result = await attemptSend(queued, consentState, sender, clock)

  const history = result.sent !== undefined ? recordSent(state.history, result.sent) : state.history

  return { transport: result.state, history, sent: result.sent !== undefined }
}
