// Renews the light client's checkpoint at run time when the release's and the stored one have both aged past the
// limit, or when the beacon server found the one in use unusable: the finalized head is asked of at least two independent
// beacon servers, and the checkpoint is the block at the newest finalized epoch's first slot that the light client's own
// consensus server can bootstrap from, used only if every server answers and they agree exactly (ADR-0092, ADR-0098).
// No `electron` import: the request, the clock and the servers come in.

import { BLOCK_ROOT_PATTERN } from '../../protocols/verifier-host/protocol.js'
import { FUTURE_TOLERANCE_SECONDS, MAX_CHECKPOINT_AGE_SECONDS, slotTimestamp } from './checkpoint.js'

export type FetchProblem = 'unreachable' | 'malformed' | 'not-finalized' | 'disagree' | 'future' | 'too-old' | 'too-few-servers' | 'no-bootstrap'

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

/** A server answered 404: it has nothing at that path, which is an answer, unlike a server that cannot be reached. */
export class NotFoundAnswer extends Error {}

/** The path that names the finalized block: the server vouches for finality in answering it. */
export const FINALIZED_HEADER_PATH = '/eth/v1/beacon/headers/finalized'

export const SLOTS_PER_EPOCH = 32
/** How many finalized epochs back from the newest the search goes for a block the bootstrap is served for: about fifty minutes. */
export const MAX_EPOCHS_BACK = 8
/** The path that names the block root at a slot; a slot with no block has none. */
export const blockRootPath = (slot: number): string => `/eth/v1/beacon/blocks/${String(slot)}/root`
/** The path the light client fetches its starting point from. */
export const BOOTSTRAP_SEGMENT = '/eth/v1/beacon/light_client/bootstrap/'
export const bootstrapPath = (root: string): string => `${BOOTSTRAP_SEGMENT}${root}`

type Answer = { readonly root: string, readonly slot: number, readonly finalized: boolean | undefined } | 'malformed' | 'not-finalized'

/**
 * The root and slot a finalized-header answer names, or why it cannot be used. A server may leave out the flags; it may not
 * set `canonical` or `execution_optimistic` against the answer. Its `finalized` flag is passed on, not judged here: Lodestar
 * sets it false on the very block it names as finalized, so `fetchAgreedCheckpoint` weighs it against the other servers.
 */
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
  if (optimistic === true || canonical === false) return 'not-finalized'
  return { root, slot, finalized: typeof finalized === 'boolean' ? finalized : undefined }
}

/** Why the answers cannot be used, the most basic reason first; undefined when every server gave a usable header. */
function firstProblem (answers: readonly Answer[]): FetchProblem | undefined {
  if (answers.includes('malformed')) return 'malformed'
  if (answers.includes('not-finalized')) return 'not-finalized'
  return undefined
}

type RootAnswer = { readonly kind: 'root', readonly root: string } | { readonly kind: 'none' } | { readonly kind: 'malformed' } | { readonly kind: 'not-finalized' } | { readonly kind: 'unreachable' }

/** The block root a server names at a slot: `none` when it has no block there, which is its answer and not a failure. */
async function rootAt (get: (url: string) => Promise<unknown>, server: string, slot: number): Promise<RootAnswer> {
  try {
    const body = await get(`${server}${blockRootPath(slot)}`) as { data?: { root?: unknown }, execution_optimistic?: unknown } | null
    const root = body?.data?.root
    if (typeof root !== 'string' || !BLOCK_ROOT_PATTERN.test(root)) return { kind: 'malformed' }
    return body?.execution_optimistic === true ? { kind: 'not-finalized' } : { kind: 'root', root }
  } catch (error) {
    if (error instanceof NotFoundAnswer) return { kind: 'none' }
    return error instanceof MalformedAnswer ? { kind: 'malformed' } : { kind: 'unreachable' }
  }
}

/** Whether the server serves the light client's bootstrap for the root, and from which slot; `missing` is its 404. */
async function bootstrapSlot (get: (url: string) => Promise<unknown>, server: string, root: string): Promise<number | 'missing' | 'malformed' | 'unreachable'> {
  try {
    const body = await get(`${server}${bootstrapPath(root)}`) as { data?: { header?: { beacon?: { slot?: unknown } } } } | null
    const slot = body?.data?.header?.beacon?.slot
    return typeof slot === 'string' && /^\d{1,12}$/.test(slot) ? Number(slot) : 'malformed'
  } catch (error) {
    if (error instanceof NotFoundAnswer) return 'missing'
    return error instanceof MalformedAnswer ? 'malformed' : 'unreachable'
  }
}

/** The longest one attempt may take, however many servers and epochs it goes through: requests wait for it (`listeningGate.hold`). */
export const ATTEMPT_DEADLINE_MS = 20_000

export interface FetchOptions {
  /** Roots the consensus server was found to have no bootstrap for: none is taken, the walk goes on past it. */
  readonly unserved?: ReadonlySet<string>
  readonly deadlineMs?: number
}

/**
 * The checkpoint is the block at the first slot of the newest finalized epoch whose block the consensus server will bootstrap
 * the light client from. Every server is asked for its finalized header at once and they must name the same one. From that
 * header's epoch, going back at most `MAX_EPOCHS_BACK` epochs, an epoch whose first slot holds no block is passed over, as is
 * one whose block the consensus server cannot bootstrap (it answers 404, or the bootstrap is for another slot) or is in
 * `unserved`: such a root would leave the light client failing at its first step. The consensus server is asked for the root
 * at the slot, then for its bootstrap while every other server is asked for the root at that slot, and they must name the same
 * one. Only the consensus server is asked for a bootstrap: it is the one server the light client bootstraps from, and the
 * others vouch for the root only, so requiring a bootstrap of them would refuse roots that serve the light client. One
 * server unreachable, or any two that differ, is a failure, and so is an attempt that outlasts `ATTEMPT_DEADLINE_MS`.
 * `get` rejects when a server cannot be reached or answers with an error status, with `NotFoundAnswer` on a 404, and with
 * `MalformedAnswer` when what came back is not JSON.
 */
export async function fetchAgreedCheckpoint (get: (url: string) => Promise<unknown>, servers: readonly string[], consensusRpc: string, nowSeconds: number, options: FetchOptions = {}): Promise<FetchOutcome> {
  const distinct = [...new Set(servers)]
  if (distinct.length < 2) return { ok: false, problem: 'too-few-servers' }
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<FetchOutcome>((resolve) => {
    timer = setTimeout(() => { expired = true; resolve({ ok: false, problem: 'unreachable' }) }, options.deadlineMs ?? ATTEMPT_DEADLINE_MS)
  })
  try {
    return await Promise.race([walk(get, distinct, consensusRpc, nowSeconds, options.unserved ?? new Set(), () => expired), deadline])
  } finally {
    clearTimeout(timer)
  }
}

async function walk (get: (url: string) => Promise<unknown>, distinct: readonly string[], consensusRpc: string, nowSeconds: number, unserved: ReadonlySet<string>, expired: () => boolean): Promise<FetchOutcome> {
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
  const flags = (answers as Array<Exclude<Answer, string>>).map((a) => a.finalized)
  if (flags.includes(false) && !flags.includes(true)) return { ok: false, problem: 'not-finalized' }
  if (slotTimestamp(first.slot) > nowSeconds + FUTURE_TOLERANCE_SECONDS) return { ok: false, problem: 'future' }
  if (nowSeconds - slotTimestamp(first.slot) > MAX_CHECKPOINT_AGE_SECONDS) return { ok: false, problem: 'too-old' }
  const ordered = [consensusRpc, ...distinct.filter((server) => server !== consensusRpc)]
  const newestEpochStart = first.slot - first.slot % SLOTS_PER_EPOCH
  for (let back = 0; back < MAX_EPOCHS_BACK && !expired(); back++) {
    const slot = newestEpochStart - back * SLOTS_PER_EPOCH
    if (slot <= 0) break
    const chosen = await rootAt(get, consensusRpc, slot)
    if (chosen.kind === 'none') continue
    if (chosen.kind !== 'root') return { ok: false, problem: chosen.kind }
    if (unserved.has(chosen.root)) continue
    const [served, others] = await Promise.all([bootstrapSlot(get, consensusRpc, chosen.root), Promise.all(ordered.slice(1).map(async (server) => await rootAt(get, server, slot)))])
    if (served === 'malformed' || served === 'unreachable') return { ok: false, problem: served }
    if (served !== slot) continue
    for (const kind of ['unreachable', 'malformed', 'not-finalized'] as const) {
      if (others.some((a) => a.kind === kind)) return { ok: false, problem: kind }
    }
    if (!others.every((a) => a.kind === 'root' && a.root === chosen.root)) return { ok: false, problem: 'disagree' }
    const timestamp = slotTimestamp(slot)
    if (nowSeconds - timestamp > MAX_CHECKPOINT_AGE_SECONDS) return { ok: false, problem: 'too-old' }
    return { ok: true, checkpoint: { root: chosen.root, slot, timestamp, servers: ordered } }
  }
  return { ok: false, problem: 'no-bootstrap' }
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
