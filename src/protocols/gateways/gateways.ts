// Trustless gateways, scheduled by health: cooling gateways are skipped,
// and each keeps its own concurrency limit so a hung one cannot starve the
// others. They are trusted for availability only: every byte they send is
// checked by the caller before use.

import { Slots } from '../resolution/slots.js'
import { Outrun } from './race.js'
import { GatewayHealth, retryAfterMs } from './gateway-health.js'
import type { GatewayOutcome } from './gateway-health.js'
import { DIRECT_ROUTE } from '../route-pace.js'
import type { RoutePace } from '../route-pace.js'
import { StallClock } from './stall.js'
import type { StallReason } from './stall.js'

export type Fetch = (url: string, init: { readonly headers: Readonly<Record<string, string>>, readonly signal: AbortSignal }) => Promise<Response>

/** A hedge waits this many times a gateway's typical answer before asking another. */
const HEDGE_LATENCY_FACTOR = 3
/** The shortest hedge delay: below it, ordinary jitter would double every request. */
export const MIN_HEDGE_DELAY_MS = 500

export interface PoolOptions {
  /** A source that sends a bad answer sits out this long instead of for the rest of the session: for a node on this computer, which a restart can make send one truncated answer, and which the person cannot replace by choosing another. */
  readonly lieQuarantineMs?: number
  /** A 5xx is the source's final answer, not a sign it is unwell: for a local node, which answers 502 or 504 once its own lookup has found nothing, and which asking again would only make search again. */
  readonly serverErrorsAreAnswers?: boolean
  /** The route this pool's requests travel: how long a request may take to its first byte, and a body go without one. Direct when unset. */
  readonly route?: RoutePace
}

export class GatewayPool {
  private readonly dropped = new Set<string>()
  private readonly health = new Map<string, GatewayHealth>()
  private readonly slots = new Map<string, Slots>()

  constructor (
    private readonly gateways: readonly string[],
    perGatewayConcurrency: number,
    private readonly clock: () => number = Date.now,
    private readonly options: PoolOptions = {}
  ) {
    if (gateways.length === 0) throw new Error('no gateway configured')
    for (const gateway of gateways) {
      this.health.set(gateway, new GatewayHealth(clock))
      this.slots.set(gateway, new Slots(perGatewayConcurrency))
    }
  }

  now (): number {
    return this.clock()
  }

  get route (): RoutePace {
    return this.options.route ?? DIRECT_ROUTE
  }

  /** Gateways still in use, in order of preference -- cooling or not. */
  usable (): string[] {
    return this.gateways.filter((g) => !this.dropped.has(g))
  }

  /** Usable AND not cooling right now, a gateway with a free slot first --
   * spreading load across gateways rather than piling onto the first
   * configured one whenever more than one can take a request immediately. */
  candidates (): string[] {
    const askable = this.usable().filter((g) => !this.health.get(g)!.cooling())
    const free: string[] = []
    const busy: string[] = []
    for (const gateway of askable) (this.slots.get(gateway)!.free ? free : busy).push(gateway)
    return [...free, ...busy]
  }

  /** When the soonest cooling-down usable gateway is worth asking again --
   * meaningful only once `candidates()` is empty. `undefined` when nothing
   * is usable at all (every gateway has been dropped for lying). */
  nextReadyAt (): number | undefined {
    const usable = this.usable()
    if (usable.length === 0) return undefined
    return Math.min(...usable.map((g) => this.health.get(g)!.readyAt()))
  }

  /** When `gateway` is worth asking again; a time already past when it is not cooling. */
  readyAt (gateway: string): number {
    return this.health.get(gateway)?.readyAt() ?? 0
  }

  /**
   * How long to wait for `gateway` before asking another as well: a few times what it typically takes, or, while it has
   * never answered, what the fastest gateway typically takes -- a gateway that stalls on what it lacks costs a moment,
   * not `maxMs` per block. Never under `MIN_HEDGE_DELAY_MS`, never over `maxMs`, and `maxMs` before any gateway answered.
   */
  hedgeDelay (gateway: string, maxMs: number): number {
    const known = this.usable().map((g) => this.health.get(g)!.typicalLatencyMs()).filter((ms): ms is number => ms !== undefined)
    const typical = this.health.get(gateway)?.typicalLatencyMs() ?? (known.length === 0 ? undefined : Math.min(...known))
    const patience = this.route.wait(maxMs)
    if (typical === undefined) return patience
    return Math.min(patience, Math.max(MIN_HEDGE_DELAY_MS, HEDGE_LATENCY_FACTOR * typical))
  }

  /** For the rest of this session: a gateway that sent one bad block is not asked again. */
  drop (gateway: string): void {
    this.dropped.add(gateway)
  }

  /** Whether a 5xx from a source is its answer that it does not have the content, to be neither retried nor cooled for. */
  get serverErrorsAreAnswers (): boolean {
    return this.options.serverErrorsAreAnswers === true
  }

  /** `gateway` sent bytes that failed their check: dropped for the session, or sat out for the pool's `lieQuarantineMs`. */
  refuse (gateway: string): void {
    if (this.options.lieQuarantineMs === undefined) this.drop(gateway)
    else this.quarantine(gateway, this.options.lieQuarantineMs)
  }

  /** Not asked for `ms`: for a source that must come back after sending one bad answer, a restarted local node among them. */
  quarantine (gateway: string, ms: number): void {
    this.health.get(gateway)?.coolFor(ms)
  }

  /** Records an outcome that was not a lie (a lie goes through `drop`
   * directly) -- rate limits, outages and timeouts cool the gateway down;
   * a miss or a plain success do not. */
  note (gateway: string, outcome: GatewayOutcome): void {
    this.health.get(gateway)?.note(outcome)
  }

  /** Runs `task` in `gateway`'s own slot, once fewer than its own
   * concurrency limit are already running against it -- never a global
   * limit shared with every other gateway, which is exactly what would let
   * one hung gateway starve the rest. */
  async withSlot<T> (gateway: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const slots = this.slots.get(gateway)
    if (slots === undefined) throw new Error(`${gateway} is not a configured gateway`)
    return await slots.run(task, signal)
  }
}

export class TooLarge extends Error {
  override readonly name = 'TooLarge'
}

/** What a fetch throws when the gateway answered with a redirect it is never allowed to follow. */
export class RedirectRefused extends Error {
  override readonly name = 'RedirectRefused'
}

/** The whole body, or TooLarge as soon as it passes `max` bytes, without reading further. */
export async function readCapped (response: Response, max: number, onProgress: () => void = () => {}): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel()
    throw new TooLarge(`declared ${String(declared)} bytes, over ${String(max)}`)
  }
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    onProgress()
    total += value.length
    if (total > max) {
      await reader.cancel()
      throw new TooLarge(`over ${String(max)} bytes`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** How one request to one gateway failed: a `GatewayOutcome` recorded
 * against it, or `cancelled`, which never is (the caller stopped wanting the
 * answer, which says nothing about the gateway). */
type RecordedFailure = Exclude<GatewayOutcome, { readonly kind: 'ok' }>
export type GatewayFailureOutcome = RecordedFailure | { readonly kind: 'cancelled' }

/** Shared by block fetches and IPNS lookups, so a 429 backs a gateway off
 * the same way whoever asked. */
export class GatewayFailure extends Error {
  override readonly name = 'GatewayFailure'
  /** @param status the HTTP status of an answer that was not a success, when there was one */
  constructor (readonly outcome: GatewayFailureOutcome, message: string, readonly status?: number) {
    super(message)
  }
}

/** Statuses a gateway answers while it is the one that is unwell, as opposed to not having the block. */
const SERVER_ERRORS: ReadonlySet<number> = new Set([500, 502, 503, 504])

const CANCELLED = 'the caller no longer needs this attempt'

/** What a stopped transfer says of why: which of its three clocks ran out. */
function stalled (reason: StallReason): string {
  return reason === 'first-byte' ? 'sent nothing in time' : reason === 'stall' ? 'stopped sending' : 'took too long overall'
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface GatewayRequest {
  readonly url: string
  readonly accept: string
  /** How long the answer's first byte may take on a direct connection; the pool's route stretches it. */
  readonly timeoutMs: number
  /** The most the body may hold: with the route's pace it bounds the whole transfer, so a source that trickles for ever still ends. */
  readonly maxBytes: number
}

/**
 * Fetches `req.url` from `gateway`, in its own slot, and reads the response
 * with `read` -- classifying whatever happens into a `GatewayOutcome`
 * before it reaches the caller, and recording it against the gateway
 * (`pool.note`) so the next `candidates()` call reflects it. Throws
 * `GatewayFailure`, never anything else, so a caller racing several of
 * these never has to catch two different shapes of error. `signal`
 * aborting (the caller no longer needs this attempt, e.g. its sibling in a
 * hedge already won) is `{ kind: 'cancelled' }` and is NOT recorded against
 * the gateway -- it says nothing about how the gateway is doing -- except
 * when the reason is `Outrun` and no headers had arrived: a gateway that
 * had the head start and sent nothing is noted as a timeout.
 */
export async function askGateway<T> (
  pool: GatewayPool,
  fetch: Fetch,
  gateway: string,
  req: GatewayRequest,
  read: (response: Response, progress: () => void) => Promise<T>,
  signal: AbortSignal
): Promise<T> {
  return await pool.withSlot(gateway, async () => {
    const startedAt = pool.now()
    // A request fails when it stops moving (no first byte in the route's time, or a body that goes quiet), never
    // because a clock written for a fast connection ran out while bytes were still arriving.
    const { route } = pool
    const clock = new StallClock({ firstByteMs: route.firstWait(req.timeoutMs), stallMs: route.stallMs(), capMs: route.firstWait(req.timeoutMs) + route.transferMs(req.maxBytes) })
    try {
      let response: Response
      try {
        response = await fetch(req.url, { headers: { accept: req.accept }, signal: AbortSignal.any([signal, clock.signal]) })
      } catch (error) {
        if (signal.aborted) {
          if (signal.reason instanceof Outrun) pool.note(gateway, { kind: 'timeout' })
          throw new GatewayFailure({ kind: 'cancelled' }, CANCELLED)
        }
        // A redirect is how some gateways refuse a single item (a content filter): it says nothing about
        // the gateway being up, so it must not cool it for the next item.
        const outcome: RecordedFailure = error instanceof RedirectRefused ? { kind: 'miss' } : { kind: clock.signal.aborted ? 'timeout' : 'unreachable' }
        pool.note(gateway, outcome)
        throw new GatewayFailure(outcome, `${gateway}: ${clock.reason === undefined ? message(error) : `${stalled(clock.reason)} (${message(error)})`}`)
      }
      clock.progress()
      const retryAfter = response.headers.get('retry-after')
      if (response.status === 429 || (response.status === 503 && retryAfter !== null)) {
        await response.body?.cancel()
        const outcome: RecordedFailure = { kind: 'rate-limited', retryAfterMs: retryAfterMs(retryAfter, pool.now()) }
        pool.note(gateway, outcome)
        throw new GatewayFailure(outcome, `${gateway} answered ${String(response.status)}`)
      }
      if (!response.ok) {
        await response.body?.cancel()
        const outcome: RecordedFailure = SERVER_ERRORS.has(response.status) && !pool.serverErrorsAreAnswers ? { kind: 'server-error' } : { kind: 'miss' }
        pool.note(gateway, outcome)
        throw new GatewayFailure(outcome, `${gateway} answered ${String(response.status)}`, response.status)
      }
      route.observeFirstByte(pool.now() - startedAt)
      try {
        const value = await read(response, () => { clock.progress() })
        pool.note(gateway, { kind: 'ok', latencyMs: pool.now() - startedAt })
        return value
      } catch (error) {
        // A hedge loser abandoned mid-body lands here as an abort too, and
        // must not cool down an honest gateway for losing a race.
        if (signal.aborted) throw new GatewayFailure({ kind: 'cancelled' }, CANCELLED)
        // TooLarge is the gateway sending something outside the block/record
        // spec, not an outage; anything else is a body that broke mid-read.
        const outcome: RecordedFailure = error instanceof TooLarge ? { kind: 'miss' } : { kind: clock.signal.aborted ? 'timeout' : 'unreachable' }
        pool.note(gateway, outcome)
        throw new GatewayFailure(outcome, `${gateway}: ${clock.reason === undefined ? message(error) : `${stalled(clock.reason)} (${message(error)})`}`)
      }
    } finally {
      clock.finish()
    }
  }, signal)
}
