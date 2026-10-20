// Renews the light client's checkpoint at run time when the release's and the stored one have both aged past the
// limit: a finalized block header is asked of at least two independent beacon servers, and used only if every one
// answers and they agree exactly (ADR-0092). No `electron` import: the request, the clock and the servers come in.

import { BLOCK_ROOT_PATTERN } from '../../protocols/verifier-host/protocol.js'
import { FUTURE_TOLERANCE_SECONDS, MAX_CHECKPOINT_AGE_SECONDS, slotTimestamp } from './checkpoint.js'

export type FetchProblem = 'unreachable' | 'malformed' | 'not-finalized' | 'disagree' | 'future' | 'too-old' | 'too-few-servers'

export interface FetchedCheckpoint {
  readonly root: string
  readonly slot: number
  /** Unix seconds of the slot. */
  readonly timestamp: number
  /** The servers that gave this exact answer. */
  readonly servers: readonly string[]
}

export type FetchOutcome =
  | { readonly ok: true, readonly checkpoint: FetchedCheckpoint }
  | { readonly ok: false, readonly problem: FetchProblem }

/** A server answered, but with a body that is not JSON or is too large to be a header. */
export class MalformedAnswer extends Error {}

/** The path that names the finalized block: the server vouches for finality in answering it. */
export const FINALIZED_HEADER_PATH = '/eth/v1/beacon/headers/finalized'

type Answer = { readonly root: string, readonly slot: number } | 'malformed' | 'not-finalized'

/** The root and slot a finalized-header answer names, or why it cannot be used. A server may leave out the flags; it may not set them against the answer. */
export function readFinalizedHeader (body: unknown): Answer {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'malformed'
  const { data, finalized, execution_optimistic: optimistic } = body as { data?: unknown, finalized?: unknown, execution_optimistic?: unknown }
  if (typeof data !== 'object' || data === null) return 'malformed'
  const { root, canonical, header } = data as { root?: unknown, canonical?: unknown, header?: { message?: { slot?: unknown } } }
  if (typeof root !== 'string' || !BLOCK_ROOT_PATTERN.test(root)) return 'malformed'
  const rawSlot = header?.message?.slot
  if (typeof rawSlot !== 'string' || !/^\d{1,12}$/.test(rawSlot)) return 'malformed'
  const slot = Number(rawSlot)
  if (!Number.isSafeInteger(slot) || slot <= 0) return 'malformed'
  if (finalized === false || optimistic === true || canonical === false) return 'not-finalized'
  return { root, slot }
}

/** Why the answers cannot be used, the most basic reason first; undefined when every server gave a usable header. */
function firstProblem (answers: readonly Answer[]): FetchProblem | undefined {
  if (answers.includes('malformed')) return 'malformed'
  if (answers.includes('not-finalized')) return 'not-finalized'
  return undefined
}

/**
 * Asks every server for its finalized header at once. The checkpoint is used only when all of them answered, all say
 * the same root and slot, and its time is neither beyond the clock's tolerance nor past the age limit. One server
 * unreachable is a failure: a single server alone is exactly what this refuses to trust.
 * `get` rejects when a server cannot be reached or answers with an error status, and rejects with `MalformedAnswer`
 * when what came back is not JSON.
 */
export async function fetchAgreedCheckpoint (get: (url: string) => Promise<unknown>, servers: readonly string[], nowSeconds: number): Promise<FetchOutcome> {
  const distinct = [...new Set(servers)]
  if (distinct.length < 2) return { ok: false, problem: 'too-few-servers' }
  const settled = await Promise.all(distinct.map(async (server): Promise<Answer | 'unreachable'> => {
    try {
      return readFinalizedHeader(await get(`${server}${FINALIZED_HEADER_PATH}`))
    } catch (error) {
      return error instanceof MalformedAnswer ? 'malformed' : 'unreachable'
    }
  }))
  if (settled.includes('unreachable')) return { ok: false, problem: 'unreachable' }
  const answers = settled as Answer[]
  const problem = firstProblem(answers)
  if (problem !== undefined) return { ok: false, problem }
  const [first] = answers as Array<Exclude<Answer, string>>
  if (first === undefined || !answers.every((a) => typeof a !== 'string' && a.root === first.root && a.slot === first.slot)) return { ok: false, problem: 'disagree' }
  const timestamp = slotTimestamp(first.slot)
  if (timestamp > nowSeconds + FUTURE_TOLERANCE_SECONDS) return { ok: false, problem: 'future' }
  if (nowSeconds - timestamp > MAX_CHECKPOINT_AGE_SECONDS) return { ok: false, problem: 'too-old' }
  return { ok: true, checkpoint: { root: first.root, slot: first.slot, timestamp, servers: distinct } }
}

/** The wait after a first failure, doubled with each one after it. */
export const FIRST_BACKOFF_MS = 5 * 60_000
export const MAX_BACKOFF_MS = 60 * 60_000

export interface FetcherDeps {
  /** One attempt, start to end. */
  readonly run: () => Promise<FetchOutcome>
  readonly now: () => number
}

/** At most one attempt in flight, and after a failure none until the wait has passed: a person who keeps opening `.eth` names offline asks the servers once per wait, not once per open. */
export class CheckpointFetcher {
  private inFlight: Promise<FetchOutcome> | undefined
  private failures = 0
  private retryAt = 0
  private last: FetchOutcome | undefined

  constructor (private readonly deps: FetcherDeps) {}

  /** Whether `renew` would reach the servers now. */
  mayAttempt (): boolean {
    return this.inFlight === undefined && this.deps.now() >= this.retryAt
  }

  /** Whether an attempt is in flight. */
  get busy (): boolean {
    return this.inFlight !== undefined
  }

  /** Why the last attempt failed, until one succeeds. */
  lastProblem (): FetchProblem | undefined {
    return this.last?.ok === false ? this.last.problem : undefined
  }

  /** The attempt in flight, or a new one; within the wait after a failure, that failure again. */
  async renew (): Promise<FetchOutcome> {
    if (this.inFlight !== undefined) return await this.inFlight
    if (this.last?.ok === false && this.deps.now() < this.retryAt) return this.last
    const attempt = this.deps.run().catch((): FetchOutcome => ({ ok: false, problem: 'unreachable' }))
    this.inFlight = attempt
    try {
      const outcome = await attempt
      if (outcome.ok) {
        this.failures = 0
        this.retryAt = 0
        this.last = undefined
      } else {
        this.failures += 1
        this.retryAt = this.deps.now() + Math.min(FIRST_BACKOFF_MS * 2 ** (this.failures - 1), MAX_BACKOFF_MS)
        this.last = outcome
      }
      return outcome
    } finally {
      this.inFlight = undefined
    }
  }
}
