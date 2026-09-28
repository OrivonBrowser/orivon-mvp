// Trustless gateways, scheduled by health: cooling gateways are skipped,
// and each keeps its own concurrency limit so a hung one cannot starve the
// others. They are trusted for availability only: every byte they send is
// checked by the caller before use.

import { Slots } from '../resolution/slots.js'
import { GatewayHealth, retryAfterMs } from './gateway-health.js'
import type { GatewayOutcome } from './gateway-health.js'

export type Fetch = (url: string, init: { readonly headers: Readonly<Record<string, string>>, readonly signal: AbortSignal }) => Promise<Response>

export class GatewayPool {
  private readonly dropped = new Set<string>()
  private readonly health = new Map<string, GatewayHealth>()
  private readonly slots = new Map<string, Slots>()

  constructor (
    private readonly gateways: readonly string[],
    perGatewayConcurrency: number,
    private readonly clock: () => number = Date.now
  ) {
    if (gateways.length === 0) throw new Error('no IPFS gateway configured')
    for (const gateway of gateways) {
      this.health.set(gateway, new GatewayHealth(clock))
      this.slots.set(gateway, new Slots(perGatewayConcurrency))
    }
  }

  now (): number {
    return this.clock()
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

  /** For the rest of this session: a gateway that sent one bad block is not asked again. */
  drop (gateway: string): void {
    this.dropped.add(gateway)
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

/** The whole body, or TooLarge as soon as it passes `max` bytes, without reading further. */
export async function readCapped (response: Response, max: number): Promise<Uint8Array> {
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

/** One request to one gateway, classified into a `GatewayOutcome` and
 * recorded against it -- shared by block fetches and IPNS lookups (both go
 * through exactly one place that decides "was this gateway's fault", Rule
 * 3), so a 429 backs a gateway off the same way regardless of who asked. */
export class GatewayFailure extends Error {
  override readonly name = 'GatewayFailure'
  constructor (readonly outcome: GatewayOutcome | { readonly kind: 'cancelled' }, message: string) {
    super(message)
  }
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface GatewayRequest {
  readonly url: string
  readonly accept: string
  readonly timeoutMs: number
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
 * the gateway -- it says nothing about how the gateway is doing.
 */
export async function askGateway<T> (
  pool: GatewayPool,
  fetch: Fetch,
  gateway: string,
  req: GatewayRequest,
  read: (response: Response) => Promise<T>,
  signal: AbortSignal
): Promise<T> {
  return await pool.withSlot(gateway, async () => {
    const timeout = AbortSignal.timeout(req.timeoutMs)
    let response: Response
    try {
      response = await fetch(req.url, { headers: { accept: req.accept }, signal: AbortSignal.any([signal, timeout]) })
    } catch (error) {
      if (signal.aborted) throw new GatewayFailure({ kind: 'cancelled' }, 'the caller no longer needs this attempt')
      const outcome: GatewayOutcome = { kind: timeout.aborted ? 'timeout' : 'unreachable' }
      pool.note(gateway, outcome)
      throw new GatewayFailure(outcome, `${gateway}: ${message(error)}`)
    }
    const retryAfter = response.headers.get('retry-after')
    if (response.status === 429 || (response.status === 503 && retryAfter !== null)) {
      await response.body?.cancel()
      const outcome: GatewayOutcome = { kind: 'rate-limited', retryAfterMs: retryAfterMs(retryAfter, pool.now()) }
      pool.note(gateway, outcome)
      throw new GatewayFailure(outcome, `${gateway} answered ${String(response.status)}`)
    }
    if (!response.ok) {
      await response.body?.cancel()
      pool.note(gateway, { kind: 'miss' })
      throw new GatewayFailure({ kind: 'miss' }, `${gateway} answered ${String(response.status)}`)
    }
    try {
      const value = await read(response)
      pool.note(gateway, { kind: 'ok' })
      return value
    } catch (error) {
      // TooLarge is the gateway sending something outside the block/record
      // spec, not an outage; anything else here is a body that started
      // (2xx headers) and then broke mid-read, which is the shape a
      // connection genuinely dying partway through takes.
      const outcome: GatewayOutcome = error instanceof TooLarge ? { kind: 'miss' } : { kind: 'unreachable' }
      pool.note(gateway, outcome)
      throw new GatewayFailure(outcome, `${gateway}: ${message(error)}`)
    }
  }, signal)
}
