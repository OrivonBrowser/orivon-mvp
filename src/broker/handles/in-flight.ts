// The per-origin in-flight budget (T11b): at most LIMITS.inFlightOperations
// of one origin's operations run at once. Past it an operation waits for a
// slot, in a bounded FIFO and for a bounded time, rather than failing at once.
// See README.md's Design notes for why a bounded wait keeps T11b's guarantee.

import { LIMITS } from '../../contracts/index.js'
import { fail } from '../errors.js'
import type { OriginTable } from './handle-store.js'

/** How many operations one origin may have waiting for a slot. Past it a call is refused with 'limit'. */
export const IN_FLIGHT_QUEUE_LIMIT = LIMITS.inFlightOperations

/** How long one operation may wait for a slot before it is refused with 'limit'. */
export const IN_FLIGHT_WAIT_MS = 10_000

export interface SlotWaiter {
  admitted: boolean
  readonly admit: () => void
}

/** True when a new operation could neither run nor wait -- checked before anything is allocated for it. */
export function queueFull (table: OriginTable): boolean {
  return table.inFlight >= LIMITS.inFlightOperations && table.slotWaiters.length >= IN_FLIGHT_QUEUE_LIMIT
}

function unqueue (table: OriginTable, waiter: SlotWaiter): void {
  const at = table.slotWaiters.indexOf(waiter)
  if (at !== -1) table.slotWaiters.splice(at, 1)
}

/**
 * Takes a free slot synchronously, if there is one and nobody is already
 * waiting for it. Synchronous on purpose: an operation with a free slot must
 * start in the same turn it was asked for, as it always has.
 */
export function tryTakeSlot (table: OriginTable): boolean {
  if (table.inFlight >= LIMITS.inFlightOperations || table.slotWaiters.length > 0) return false
  table.inFlight += 1
  return true
}

/**
 * Resolves once the caller holds one of `table`'s slots, which it must give
 * back with `releaseSlot`. Rejects 'limit' when the queue is full or the wait
 * runs out, and with `cancelled`'s own error when that fires first -- holding
 * no slot either way.
 */
export async function waitForSlot (table: OriginTable, cancelled: Promise<never>): Promise<void> {
  if (queueFull(table)) throw fail('limit', `origin has ${String(LIMITS.inFlightOperations)} operations in flight and as many waiting`)

  let resolveAdmitted!: () => void
  let expire!: (error: unknown) => void
  const admitted = new Promise<void>((resolve, reject) => { resolveAdmitted = resolve; expire = reject })
  const waiter: SlotWaiter = { admitted: false, admit: () => { waiter.admitted = true; resolveAdmitted() } }
  table.slotWaiters.push(waiter)
  const timer = setTimeout(() => {
    if (waiter.admitted) return
    unqueue(table, waiter)
    expire(fail('limit', `no in-flight slot freed within ${String(IN_FLIGHT_WAIT_MS)}ms`))
  }, IN_FLIGHT_WAIT_MS)
  timer.unref?.()

  try {
    await Promise.race([admitted, cancelled])
  } catch (error) {
    unqueue(table, waiter)
    // Cancelled in the same turn a slot was handed over: give it back, or
    // it is lost for good.
    if (waiter.admitted) releaseSlot(table)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Gives a slot back: straight to the oldest waiter if there is one, so nothing can overtake the queue. */
export function releaseSlot (table: OriginTable): void {
  const next = table.slotWaiters.shift()
  if (next === undefined) table.inFlight -= 1
  else next.admit()
}
