// Shared fixtures for handles.test.ts and handles-limits.test.ts (split out of
// one file that exceeded docs/development/code-guidelines.md's 800-line test
// limit). Not *.test.ts, so vitest does not collect it as its own suite.

import { vi } from 'vitest'
import type { OrivonError } from '../contracts/index.js'
import { HandleTable } from './handles.js'
import type { CloseReason } from './handle-contracts.js'

export const APP = 'https://app.example'
export const OTHER = 'https://other.example'
export const TCP_GRANT = 'grant-tcp-connect'
export const FS_GRANT = 'grant-fs'

export function table (): HandleTable {
  return new HandleTable()
}

/** A destroy hook that records the reason it was called with. */
export function spyDestroy (): ReturnType<typeof vi.fn<(reason: CloseReason) => void>> {
  return vi.fn<(reason: CloseReason) => void>()
}

export function noop (): void {}

/** Runs `fn`, returning the OrivonError it threw. Fails if it did not throw. */
export function thrown (fn: () => unknown): OrivonError {
  try {
    fn()
  } catch (error) {
    return error as OrivonError
  }
  throw new Error('expected the call to throw, and it returned instead')
}

/** Awaits `promise`, returning the OrivonError it rejected with. */
export async function rejection (promise: Promise<unknown>): Promise<OrivonError> {
  try {
    await promise
  } catch (error) {
    return error as OrivonError
  }
  throw new Error('expected the promise to reject, and it resolved instead')
}

/** A promise that never settles -- an operation still in flight. */
export function never<T> (): Promise<T> {
  return new Promise<T>(() => {})
}

const PENDING = Symbol('pending')

/**
 * The outcome of `promise` as of the next macrotask, WITHOUT waiting for it.
 *
 * This is what separates "rejects immediately" from "queues and rejects
 * later": an implementation that waits for a free slot leaves the promise
 * pending here, and the assertion fails in milliseconds instead of hanging
 * until the test times out.
 */
export async function outcomeNow<T> (promise: Promise<T>): Promise<
  { readonly state: 'pending' } | { readonly state: 'rejected', readonly error: OrivonError } | { readonly state: 'resolved', readonly value: T }
> {
  const tick = new Promise<typeof PENDING>((resolve) => { setTimeout(() => { resolve(PENDING) }, 0) })
  const settled = promise.then(
    (value) => ({ state: 'resolved' as const, value }),
    (error: OrivonError) => ({ state: 'rejected' as const, error })
  )
  const outcome = await Promise.race([settled, tick])
  return outcome === PENDING ? { state: 'pending' } : outcome
}

export function acquireSocket (t: HandleTable, origin = APP, grantId = TCP_GRANT): ReturnType<HandleTable['acquire']> {
  return t.acquire({ origin, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId }, destroy: noop })
}
