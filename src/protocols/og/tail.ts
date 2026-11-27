import { ChainError } from './chain.js'
import type { Chain, Log, LogFilter, Transaction } from './chain.js'

// The log scans of one resolver's life, and the time they are allowed. History comes in two stretches. The newest 8,000 blocks are
// read through the light client, which proves a log against its block, as windows of at most 1024 blocks, eight in flight at once.
// Before them, back to the census, the light client proves nothing (it knows the last 8,191 blocks and no more), so the servers are
// asked, unproven, in windows of 9,000 blocks, two in flight at once, and asked again after a wait when they rate limit. The turns are
// shared out between the calls that want them, and a window is timed from the moment it is let go. Every window read at or below the
// final block is kept in memory as the call that reads it, so a scan that ran out of time leaves what it read for the next one, and two
// lookups that need the same window (the resolver check is every name's) make the one call. A scan never answers in part: out of time
// it refuses in words and says to ask again. The transactions behind a name's registry logs are read the same way, one call each,
// kept by hash, through the stretch their block lies in. A read of the servers is cut at the time of the call that let it go: a call that
// comes after that time begins the read again, and one that joined it before and saw it cut asks again while it has time left.

/** The widest stretch one call reads through the light client. */
export const WINDOW = 1024

/** How far back from the newest block the light client is asked: under the 8,191 blocks it proves, with room for the blocks that come while a scan runs. */
export const PROVEN_SPAN = 8_000

/** The widest stretch one call reads from the servers: under the 10,000 blocks the widest of them answers. */
export const OLD_WINDOW = 9_000

/** Windows of old history in flight at once: the servers that answer them rate limit bursts. */
export const OLD_IN_FLIGHT = 2

/**
 * The narrowest range a server is asked to answer: a refused range is halved while each half keeps this many blocks, then cut at it.
 * A server that refuses a range this narrow is not read.
 */
export const MIN_OLD_WINDOW = WINDOW

/** The wait before a rate-limited read is asked again: doubling to its cap, or what the server asked when it said (never less than the first). */
export const BACKOFF_FIRST_MS = 1_000
export const BACKOFF_CAP_MS = 8_000

/** How many times a rate-limited read is asked again before it gives up. */
export const BACKOFF_TRIES = 5

/** What one window of old history is expected to take until some have been read. */
export const FIRST_OLD_WINDOW_MS = 6_000

/** Windows one scan asks at once. */
export const CONCURRENCY = 8

/** Windows in flight at once, whichever scans and calls want them. */
export const WINDOWS_IN_FLIGHT = 8

/** What a call keeps for itself after its scans: the freshness rule and the answer, which take no node call. */
export const FINISH_RESERVE_MS = 2_000

/** What one window is expected to take until some have been read: a light client reads a window of a few blocks with a log in about a second. */
export const FIRST_WINDOW_MS = 3_000

/** The first block the light client is asked for when the newest is `head`: on a multiple of `WINDOW`, so the windows of two calls line up and the kept ones are used again. */
export const provenFromOf = (head: number): number => Math.ceil(Math.max(0, head - PROVEN_SPAN) / WINDOW) * WINDOW

/** How much of the pace estimate the newest window decides: the rest is what the windows before it said, so a slow stretch is forgotten as fast ones come. */
const NEWEST_WINDOW = 0.3

/** A refusal in words: the answer cannot be given safely or in time. The resolver turns it into an `unavailable` failure carrying the words. */
export class OgRefusal extends Error {
  override readonly name = 'OgRefusal'
}

/** A read of the servers that stopped because the call's time ran out: the scan that wanted it stops and says so, in words, as any scan out of time. */
class TimeRanOut extends Error {
  override readonly name = 'TimeRanOut'
}

/** Who a window is read for: one lookup, with all the scans it needs. A call has the resolver's turns in common with every other call. */
export type Call = object

/** What a resolver remembers between lookups. */
export interface Session {
  /** Each window asked, by source, scan and range, as the call that reads it. */
  readonly windows: Map<string, Read<Log[]>>
  /** Each transaction the light client was asked for, by lower-case hash, as the call that reads it. */
  readonly transactions: Map<string, Read<Transaction | null>>
  /** The same for the servers' word, which never answers a read of the light client's stretch. */
  readonly serverTransactions: Map<string, Read<Transaction | null>>
  /** The windows read so far and how long one takes from the moment it is let go, weighted to the latest. */
  readonly pace: Pace
  /** The same for the windows of old history, which the servers answer. */
  readonly oldPace: Pace
  readonly now: () => number
  /** Waits `ms`, for a read that is asked again after a rate limit. */
  readonly sleep: (ms: number) => Promise<void>
  readonly launcher: Launcher
  /** The turns the servers' windows take: fewer, since they rate limit. */
  readonly oldLauncher: Launcher
  /** When the servers may be asked again: a rate limit told one call, and the others wait it out too. */
  readonly cooling: { until: number }
}

/**
 * A read in flight or kept. `until` is the time of the call that let it go, for a read of the servers, which that time cuts: a read
 * left behind by a call that ran out of time is not joined by a later call, which begins its own. It is `Infinity` for a read the time
 * does not cut (the light client's) and once a read has ended and is kept.
 */
export interface Read<T> {
  readonly pending: Promise<T>
  until: number
}

export interface Pace { done: number, ms: number }

export function createSession (options: { now?: () => number, sleep?: (ms: number) => Promise<void>, windowsInFlight?: number } = {}): Session {
  return {
    windows: new Map(),
    transactions: new Map(),
    serverTransactions: new Map(),
    pace: { done: 0, ms: 0 },
    oldPace: { done: 0, ms: 0 },
    now: options.now ?? Date.now,
    sleep: options.sleep ?? (async (ms) => { await new Promise((resolve) => setTimeout(resolve, ms)) }),
    launcher: createLauncher(options.windowsInFlight ?? WINDOWS_IN_FLIGHT),
    oldLauncher: createLauncher(OLD_IN_FLIGHT),
    cooling: { until: 0 }
  }
}

export const newCall = (): Call => ({})

/** The turns a resolver's windows take at the node. */
export interface Launcher {
  /** Resolves true when the call may let a window go, false when `until` came first, and rejects when the signal fires. */
  acquire: (call: Call, wait: { until: number, now: () => number, signal?: AbortSignal | undefined }) => Promise<boolean>
  /** Gives the turn back, when the window it was for has been answered or failed. */
  release: (call: Call) => void
}

interface Waiting { call: Call, order: number, grant: () => void }

/**
 * Lets at most `slots` windows go at once. A turn goes to the call holding the fewest windows, then to the one that has waited
 * longest: no call keeps another waiting for all of its windows.
 */
function createLauncher (slots: number): Launcher {
  let open = 0
  let arrivals = 0
  const held = new Map<Call, number>()
  const waiting: Waiting[] = []

  const take = (call: Call): void => { open++; held.set(call, (held.get(call) ?? 0) + 1) }
  const goesBefore = (a: Waiting, b: Waiting): boolean => {
    const left = held.get(a.call) ?? 0
    const right = held.get(b.call) ?? 0
    return left !== right ? left < right : a.order < b.order
  }

  function pump (): void {
    while (open < slots && waiting.length > 0) {
      let best = 0
      for (let index = 1; index < waiting.length; index++) {
        if (goesBefore(waiting[index] as Waiting, waiting[best] as Waiting)) best = index
      }
      const [next] = waiting.splice(best, 1) as [Waiting]
      take(next.call)
      next.grant()
    }
  }

  return {
    acquire (call, { until, now, signal }) {
      signal?.throwIfAborted()
      if (open < slots && waiting.length === 0) {
        take(call)
        return Promise.resolve(true)
      }
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const entry: Waiting = {
          call,
          order: arrivals++,
          grant: () => { clearTimeout(timer); signal?.removeEventListener('abort', leave); resolve(true) }
        }
        const unqueue = (): boolean => { const at = waiting.indexOf(entry); if (at >= 0) waiting.splice(at, 1); return at >= 0 }
        function leave (): void { if (unqueue()) { clearTimeout(timer); reject(signal?.reason) } }
        waiting.push(entry)
        signal?.addEventListener('abort', leave, { once: true })
        if (until !== Infinity) timer = setTimeout(() => { if (unqueue()) { signal?.removeEventListener('abort', leave); resolve(false) } }, Math.max(0, until - now()))
      })
    },
    release (call) {
      open--
      const left = (held.get(call) ?? 1) - 1
      if (left <= 0) held.delete(call)
      else held.set(call, left)
      pump()
    }
  }
}

/** The windows of at most 1024 blocks that cover `from` to `to`, both ends counted. */
export function windowsOf (from: number, to: number): [number, number][] {
  const windows: [number, number][] = []
  for (let first = from; first <= to; first += WINDOW) windows.push([first, Math.min(first + WINDOW - 1, to)])
  return windows
}

/** A window of a scan: `old` for one the servers answer, unproven, and not the light client. */
export interface Stretch { readonly first: number, readonly last: number, readonly old: boolean }

/**
 * The windows that cover `from` to `to`, oldest first: the blocks before `provenFrom` in windows of `OLD_WINDOW`, the rest in windows of
 * `WINDOW`. With no `provenFrom` (a resolver given no servers) every window is the light client's.
 */
export function stretchesOf (from: number, to: number, provenFrom = Number.NEGATIVE_INFINITY): Stretch[] {
  const stretches: Stretch[] = []
  const oldEnd = Math.min(to, provenFrom - 1)
  for (let first = from; first <= oldEnd; first += OLD_WINDOW) stretches.push({ first, last: Math.min(first + OLD_WINDOW - 1, oldEnd), old: true })
  for (const [first, last] of windowsOf(Math.max(from, provenFrom), to)) stretches.push({ first, last, old: false })
  return stretches
}

/** What a window is kept under: its scan and range, and who answers it, so the servers' word is never taken for the light client's. */
const windowKey = (scan: Scan, { first, last, old }: Stretch): string => `${old ? 'servers' : 'light'}:${scan.id}:${String(first)}-${String(last)}`

/** The read under `key` that a call may join now: one that has ended and is kept, or whose call still has time. */
function joinable<T> (session: Session, reads: Map<string, Read<T>>, key: string): Read<T> | undefined {
  const read = reads.get(key)
  return read !== undefined && session.now() < read.until ? read : undefined
}

/** What one window is expected to take: one and a half times what the latest windows took, each from the moment it was let go. */
export function expectedMs (session: Session, old = false): number {
  const pace = old ? session.oldPace : session.pace
  return pace.done === 0 ? (old ? FIRST_OLD_WINDOW_MS : FIRST_WINDOW_MS) : Math.max(500, 1.5 * pace.ms)
}

export interface Scan {
  /** Which scan this is, so windows of two scans are never mixed up. */
  readonly id: string
  readonly address: LogFilter['address']
  readonly topics: readonly (string | null)[]
  /** First block. */
  readonly from: number
  /** Last block, counted. */
  readonly to: number
  /** Whether a log the node returned is one the scan asked for. */
  readonly accept: (log: Log) => boolean
  /** Whether these logs of a window make the call refuse: a window of old history that does is not kept, and the servers are asked again by the next call. */
  readonly refuses?: (logs: readonly Log[]) => boolean
}

/** What a scan or a read of transactions is allowed, and who it is for. */
export interface ScanOptions {
  /** Milliseconds since the epoch by which the call must have answered. */
  readonly deadlineAt?: number | undefined
  readonly signal?: AbortSignal | undefined
  /** The words for what is being checked, such as "the recent history of alice.og". */
  readonly what?: string
  /** Who the windows are read for: one for all the scans of a lookup (a scan of its own by default). */
  readonly call?: Call | undefined
  /** The highest block whose logs no reorganisation can change, up to which windows are kept (none by default). */
  readonly final?: number | undefined
  /** The newest block, which tells how much of the history the light client proves and how much the servers are asked (needed to read a transaction from the servers). */
  readonly head?: number | undefined
}

/**
 * One read of the servers, asked again after the wait a rate limit calls for, within `until`. A wait that would run past it, the `BACKOFF_TRIES`th
 * rate limit, and a server that asked for longer than the call has are the failure, at once; a read is never begun after `until`. The wait is
 * shared: while one read waits, no read of the servers is let go.
 */
async function backedOff<T> (session: Session, until: number, ask: () => Promise<T>): Promise<T> {
  for (let tries = 0; ; tries++) {
    const wait = session.cooling.until - session.now()
    if (wait > 0) {
      if (session.now() + wait > until) throw new ChainError('rateLimited', 'the servers asked to be left alone for longer than the call has')
      await session.sleep(wait)
    }
    if (session.now() >= until) throw new TimeRanOut()
    try {
      return await ask()
    } catch (error) {
      if (!(error instanceof ChainError) || error.reason !== 'rateLimited' || tries >= BACKOFF_TRIES) throw error
      // What the server asked is waited in full, when it fits; the wait a server did not name doubles to its cap.
      const asked = Math.max(BACKOFF_FIRST_MS, error.retryAfterMs ?? Math.min(BACKOFF_FIRST_MS * 2 ** tries, BACKOFF_CAP_MS))
      if (session.now() + asked > until) throw error
      session.cooling.until = Math.max(session.cooling.until, session.now() + asked)
    }
  }
}

/**
 * The logs of `filter` from the servers: a range they refuse as too wide is read as its two halves, down to `MIN_OLD_WINDOW`; a range whose
 * half would be narrower is read as its first `MIN_OLD_WINDOW` blocks and the rest. A range no wider than that is not split, and its refusal
 * is the failure of the window. No half is begun once `until` has passed.
 */
async function readOldLogs (servers: Chain, session: Session, filter: LogFilter, until: number): Promise<Log[]> {
  try {
    return await backedOff(session, until, async () => await servers.getLogs(filter))
  } catch (error) {
    const span = filter.toBlock - filter.fromBlock + 1
    if (!(error instanceof ChainError) || error.reason !== 'limit' || span <= MIN_OLD_WINDOW) throw error
    const second = filter.fromBlock + (Math.floor(span / 2) < MIN_OLD_WINDOW ? MIN_OLD_WINDOW : Math.ceil(span / 2))
    const before = await readOldLogs(servers, session, { ...filter, toBlock: second - 1 }, until)
    return [...before, ...await readOldLogs(servers, session, { ...filter, fromBlock: second }, until)]
  }
}

/**
 * Gives a turn back once: when the read it was for ends or at `until`, whichever comes first. A server that hangs holds no turn past the
 * time of the call that let it go; the read itself may still be running, and an answer that comes later is kept as any other.
 */
function turnBack (launcher: Launcher, call: Call, session: Session, until: number): () => void {
  let held = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const give = (): void => {
    if (!held) return
    held = false
    clearTimeout(timer)
    launcher.release(call)
  }
  if (until !== Infinity) timer = setTimeout(give, Math.max(0, until - session.now()))
  return give
}

/**
 * Lets one window go. The turn the caller holds is given back when the window has been answered or has failed. Kept for the next call
 * only when it ends at or below `final`, the highest block no reorganisation can still change; above it the node may yet answer
 * otherwise, so it is shared with the scans that want it now and dropped after. A window of old history is read from the servers.
 */
function startWindow (chain: Chain, session: Session, scan: Scan, stretch: Stretch, { call, final, until }: { call: Call, final: number, until: number }): Promise<Log[]> {
  const { first, last, old } = stretch
  const key = windowKey(scan, stretch)
  const startedAt = session.now()
  const filter: LogFilter = { fromBlock: first, toBlock: last, ...(scan.address === undefined ? {} : { address: scan.address }), topics: scan.topics }
  const read = old && chain.servers !== undefined ? readOldLogs(chain.servers, session, filter, until) : chain.getLogs(filter)
  const pending = read.then((logs) => {
    const pace = old ? session.oldPace : session.pace
    const took = Math.max(0, session.now() - startedAt)
    pace.ms = pace.done === 0 ? took : (1 - NEWEST_WINDOW) * pace.ms + NEWEST_WINDOW * took
    pace.done++
    return logs.filter((log) => !log.removed && log.blockNumber >= first && log.blockNumber <= last && scan.accept(log))
  })
  // Only a read of the servers is cut at the call's time; the light client's answers when it answers, whoever is waiting.
  const entry: Read<Log[]> = { pending, until: old ? until : Infinity }
  session.windows.set(key, entry)
  const give = turnBack(old ? session.oldLauncher : session.launcher, call, session, until)
  const done = (kept: boolean): void => {
    give()
    if (kept) entry.until = Infinity
    else if (session.windows.get(key) === entry) session.windows.delete(key)
  }
  // A window that failed is asked again by the next scan that needs it, and so is one that may still change. So is a window of old history
  // that makes the scan refuse: one server's invented log must not refuse the next call too.
  pending.then((logs) => { done(last <= final && !(old && scan.refuses?.(logs) === true)) }, () => { done(false) })
  return pending
}

/** Waits for a read that another scan or call may be making, at most until `until`: undefined when the time came first. */
async function waitUntil<T> (session: Session, pending: Promise<T>, until: number): Promise<T | undefined> {
  if (until === Infinity) return await pending
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => { resolve(undefined) }, Math.max(0, until - session.now())) })
  try {
    return await Promise.race([pending, late])
  } finally {
    clearTimeout(timer)
  }
}

function refuseOrThrow (failure: unknown, what: string): never {
  if (failure instanceof ChainError && ['badAnswer', 'invalid', 'reverted'].includes(failure.reason)) throw new OgRefusal(`The node's answer about ${what} could not be read, so these records are not vouched for.`)
  if (failure instanceof ChainError && failure.reason === 'rateLimited') throw new OgRefusal(`The servers that answer for ${what} are limiting how fast they can be asked. What was checked is kept: try again shortly.`)
  throw failure
}

/**
 * Every log of `scan` from its first block to its last, window by window. Windows already read, or being read by another scan,
 * are used as they are; the others wait for the resolver's turn at the node. A call may let at least one round of windows go however
 * slow the node has been, so a slow stretch never stops every later lookup; past that round a window is let go only when it is
 * expected to be answered in the time left. When the time left cannot take another window the scan stops and refuses, keeping what it
 * read. A node that cannot be asked throws as it is; a node whose answer cannot be read refuses.
 */
export async function scanLogs (chain: Chain, session: Session, scan: Scan, options: ScanOptions = {}): Promise<Log[]> {
  const { deadlineAt = Infinity, signal, what = 'recent history', call = newCall(), final = -Infinity } = options
  // Old history is read from the servers when there are some; without them every window is the light client's, and what it cannot prove fails.
  const ranges = stretchesOf(scan.from, scan.to, chain.servers === undefined ? undefined : provenFromOf(scan.to))
  const results = new Array<Log[] | undefined>(ranges.length)
  // The light client's windows and the servers' go at once, each from its own list in chain order: a window waiting for the servers' turn holds no worker the light client's could use.
  const queues = { proven: { at: 0, items: ranges.map((range, index) => ({ range, index })).filter(({ range }) => !range.old) }, old: { at: 0, items: ranges.map((range, index) => ({ range, index })).filter(({ range }) => range.old) } }
  let finished = 0
  let stopped = false
  let failure: unknown
  const scanDeadline = deadlineAt - FINISH_RESERVE_MS

  /**
   * The window of `stretch`: the one already asked for, or one let go now, when the resolver's turn comes and the time left allows.
   * A worker's first window of each kind in the call is let go whatever the pace says, while any time is left: `mine` tells it is not yet.
   * @returns the window, in an object so that waiting for it is the caller's; undefined when the scan stops
   */
  async function windowFor (stretch: Stretch, mine: { proven: boolean, old: boolean }): Promise<{ pending: Promise<Log[]> } | undefined> {
    const key = windowKey(scan, stretch)
    const asked = joinable(session, session.windows, key)
    if (asked !== undefined) return { pending: asked.pending }
    const launcher = stretch.old ? session.oldLauncher : session.launcher
    const kind = stretch.old ? 'old' : 'proven'
    if (!await launcher.acquire(call, { until: scanDeadline, now: session.now, signal })) return undefined
    const meanwhile = joinable(session, session.windows, key)?.pending
    const room = session.now() < scanDeadline
    const fits = session.now() + expectedMs(session, stretch.old) <= scanDeadline
    if (meanwhile !== undefined || failure !== undefined || stopped || !(fits || (!mine[kind] && room))) {
      launcher.release(call)
      return meanwhile === undefined ? undefined : { pending: meanwhile }
    }
    mine[kind] = true
    return { pending: startWindow(chain, session, scan, stretch, { call, final, until: scanDeadline }) }
  }

  /**
   * The logs of `stretch`, or undefined when this call's time ran out. A read this call joined that was cut at the time of the call that
   * began it, while this call has time left, is begun again, as a read that was never there.
   */
  async function logsOf (stretch: Stretch, mine: { proven: boolean, old: boolean }): Promise<Log[] | undefined> {
    for (;;) {
      try {
        const window = await windowFor(stretch, mine)
        return window === undefined ? undefined : await waitUntil(session, window.pending, scanDeadline)
      } catch (error) {
        if (!(error instanceof TimeRanOut)) throw error
        if (session.now() >= scanDeadline) return undefined
      }
    }
  }

  async function worker (kind: 'proven' | 'old'): Promise<void> {
    const mine = { proven: false, old: false }
    const queue = queues[kind]
    while (failure === undefined && !stopped) {
      signal?.throwIfAborted()
      const item = queue.items[queue.at++]
      if (item === undefined) return
      try {
        const logs = await logsOf(item.range, mine)
        if (logs === undefined) {
          stopped = true
          return
        }
        results[item.index] = logs
        finished++
      } catch (error) {
        failure ??= error
      }
    }
  }

  await Promise.all([
    ...Array.from({ length: Math.min(CONCURRENCY, queues.proven.items.length) }, async () => { await worker('proven') }),
    ...Array.from({ length: Math.min(OLD_IN_FLIGHT, queues.old.items.length) }, async () => { await worker('old') })
  ])
  signal?.throwIfAborted()
  if (failure !== undefined) refuseOrThrow(failure, what)
  if (stopped || finished < ranges.length) {
    throw new OgRefusal(`Still checking ${what}: ${String(ranges.length - finished)} of ${String(ranges.length)} stretches of the chain are left and the time ran out. What was checked is kept: try again shortly.`)
  }
  return results.flatMap((logs) => logs ?? [])
}

/**
 * The transactions behind some logs, each read once and kept by hash for the resolver's life when its block is at or below `final`: the
 * calls a name's registry `Changed` logs stand for. Each read waits for the resolver's turn at the node, as a window does, and none is let go
 * once the time left (less the call's own reserve) has run out. Never in part: when the time runs out, or a node has no such transaction,
 * it refuses in words and says to ask again; what was read is kept. A node that cannot be asked throws as it is.
 * @param wanted the transaction of each log, with the log's block (`options.head` tells which of them the servers are asked for)
 * @returns in the order asked
 */
export async function readTransactions (chain: Chain, session: Session, wanted: readonly { hash: string, blockNumber: number }[], options: ScanOptions = {}): Promise<Transaction[]> {
  const { deadlineAt = Infinity, signal, what = 'recent history', call = newCall(), final = -Infinity, head } = options
  const scanDeadline = deadlineAt - FINISH_RESERVE_MS
  const provenFrom = chain.servers === undefined || head === undefined ? Number.NEGATIVE_INFINITY : provenFromOf(head)

  /** Undefined when the time ran out. */
  async function readOnce ({ hash, blockNumber }: { hash: string, blockNumber: number }): Promise<Transaction | null | undefined> {
    signal?.throwIfAborted()
    const key = hash.toLowerCase()
    // A transaction of old history is read from the servers, as its log was, and kept apart from the light client's: a server's answer for a hash
    // is its own word, and a log of the light client's stretch with the same hash must be read from the light client.
    const old = blockNumber < provenFrom
    const cache = old ? session.serverTransactions : session.transactions
    const asked = joinable(session, cache, key)
    if (asked !== undefined) return await waitUntil(session, asked.pending, scanDeadline)
    const launcher = old ? session.oldLauncher : session.launcher
    if (!await launcher.acquire(call, { until: scanDeadline, now: session.now, signal })) return undefined
    const meanwhile = joinable(session, cache, key)
    if (meanwhile !== undefined || session.now() >= scanDeadline) {
      launcher.release(call)
      return meanwhile === undefined ? undefined : await waitUntil(session, meanwhile.pending, scanDeadline)
    }
    const servers = chain.servers
    const pending = old && servers !== undefined ? backedOff(session, scanDeadline, async () => await servers.getTransaction(hash)) : chain.getTransaction(hash)
    const entry: Read<Transaction | null> = { pending, until: old && servers !== undefined ? scanDeadline : Infinity }
    cache.set(key, entry)
    const give = turnBack(launcher, call, session, scanDeadline)
    const done = (kept: boolean): void => {
      give()
      if (kept) entry.until = Infinity
      else if (cache.get(key) === entry) cache.delete(key)
    }
    // An answer is kept for the resolver's life only when it is the transaction of a final block, and of the block the log claims: a node that does
    // not know one yet may know it a moment later, and one that answers another block's is not the transaction that logged it.
    pending.then((found) => { done(found !== null && found.blockNumber === blockNumber && blockNumber <= final) }, () => { done(false) })
    return await waitUntil(session, pending, scanDeadline)
  }

  /** As `readOnce`, and begun again when a read this call joined was cut at the time of the call that began it while this call has time left. */
  async function read (one: { hash: string, blockNumber: number }): Promise<Transaction | null | undefined> {
    for (;;) {
      try {
        return await readOnce(one)
      } catch (error) {
        if (!(error instanceof TimeRanOut)) throw error
        // A read of the servers that ran out of this call's own time is a transaction left, as one still waited for at the deadline.
        if (session.now() >= scanDeadline) return undefined
      }
    }
  }

  const results = await Promise.allSettled(wanted.map(read))
  signal?.throwIfAborted()
  const failed = results.find((result) => result.status === 'rejected')
  if (failed !== undefined) refuseOrThrow((failed as PromiseRejectedResult).reason, what)
  const found = results.map((result) => (result as PromiseFulfilledResult<Transaction | null | undefined>).value)
  const left = found.filter((one) => one === undefined).length
  if (left > 0) throw new OgRefusal(`Still checking ${what}: ${String(left)} of ${String(wanted.length)} transactions are left and the time ran out. What was checked is kept: try again shortly.`)
  if (found.some((one) => one === null)) throw new OgRefusal(`The node has no transaction behind ${what}, so what it did is not known and these records are not vouched for.`)
  return found as Transaction[]
}
