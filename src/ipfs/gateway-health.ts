// Per-gateway cooldown bookkeeping: how long a gateway sits out after
// answering badly, decided from the outcome alone. Pure -- no fetch, no
// clock of its own (the caller's `now` makes this testable without waiting
// on a real timer). Owns no list of gateways; gateways.ts keeps one record
// per gateway and asks this what to do with it.

/** What one request to a gateway came back as, already classified by the
 * caller (askGateway, gateways.ts) -- this module never inspects a
 * response itself. */
export type GatewayOutcome =
  | { readonly kind: 'ok' }
  /** A 429, or a 503 that named a retry time. */
  | { readonly kind: 'rate-limited', readonly retryAfterMs: number | undefined }
  /** Refused, reset, timed out connecting, or a TLS failure -- the gateway
   * never answered at all. */
  | { readonly kind: 'unreachable' }
  /** Connected and sent nothing back before the request's own deadline. */
  | { readonly kind: 'timeout' }
  /** Answered, just not with this block/record -- a 404, a 5xx with no
   * Retry-After, or a body over the size limit. Not a strike: the gateway
   * is reachable and behaving, it simply doesn't have this one. */
  | { readonly kind: 'miss' }

const RATE_LIMIT_BASE_MS = 1_000
const RATE_LIMIT_CAP_MS = 15_000
const UNREACHABLE_BASE_MS = 2_000
const UNREACHABLE_CAP_MS = 60_000
/** One timeout alone is filebase's own observed shape here: it hangs on a
 * block it doesn't have while answering everything else fine. Only a
 * SECOND one with no success in between earns a cooldown. */
const TIMEOUTS_BEFORE_COOLDOWN = 2

/** An HTTP `Retry-After` header: seconds (`"120"`) or an HTTP-date. `null`
 * or an unparseable value answers `undefined`, so the caller falls back to
 * its own default backoff instead of treating a garbled header as "now". */
export function retryAfterMs (header: string | null, now: number): number | undefined {
  if (header === null) return undefined
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - now)
}

/** One gateway's cooldown state. `note` is the only way to change it --
 * everything else here reads it. */
export class GatewayHealth {
  private cooldownUntil = 0
  private rateLimitStrikes = 0
  private unreachableStrikes = 0
  private timeoutsSinceSuccess = 0

  constructor (private readonly now: () => number = Date.now) {}

  /** Still cooling, as of `now()`. */
  cooling (): boolean {
    return this.cooldownUntil > this.now()
  }

  /** When this gateway is worth asking again -- meaningful only while
   * `cooling()` is true. */
  readyAt (): number {
    return this.cooldownUntil
  }

  note (outcome: GatewayOutcome): void {
    switch (outcome.kind) {
      case 'ok':
        // Resets the strike counters, but never lifts a cooldown already
        // running: a request that started before the 429/outage and only
        // happened to land afterward must not undo it.
        this.rateLimitStrikes = 0
        this.unreachableStrikes = 0
        this.timeoutsSinceSuccess = 0
        return
      case 'miss':
        return
      case 'rate-limited': {
        this.rateLimitStrikes += 1
        const backoff = Math.min(RATE_LIMIT_BASE_MS * 2 ** (this.rateLimitStrikes - 1), RATE_LIMIT_CAP_MS)
        const delay = Math.min(outcome.retryAfterMs ?? backoff, RATE_LIMIT_CAP_MS)
        this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + delay)
        return
      }
      case 'unreachable': {
        this.unreachableStrikes += 1
        const delay = Math.min(UNREACHABLE_BASE_MS * 2 ** (this.unreachableStrikes - 1), UNREACHABLE_CAP_MS)
        this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + delay)
        return
      }
      case 'timeout': {
        this.timeoutsSinceSuccess += 1
        if (this.timeoutsSinceSuccess < TIMEOUTS_BEFORE_COOLDOWN) return
        this.unreachableStrikes += 1
        const delay = Math.min(UNREACHABLE_BASE_MS * 2 ** (this.unreachableStrikes - 1), UNREACHABLE_CAP_MS)
        this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + delay)
      }
    }
  }
}
