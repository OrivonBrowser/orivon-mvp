// How patient a request may be on the route it travels. Every wait on the load path is written once for a direct
// connection; a route stretches it by how much slower it is, so a route added later declares three numbers and
// needs no wait of its own. Durable: pure arithmetic over an injected clock.

/** What a route declares of itself: the floor of its patience. */
export interface RouteProfile {
  /** Names the route in logs. */
  readonly id: string
  /** How long a fresh request takes to its first byte once the route is up, by this route's own account. */
  readonly roundTripMs: number
  /** How long the route may need to come up the first time it is used. */
  readonly coldStartMs: number
  /** What one transfer carries a second. */
  readonly bytesPerSecond: number
}

/** The round trip a wait written for a direct connection assumes. */
export const REFERENCE_ROUND_TRIP_MS = 500
/** The first-byte wait of a block on a direct connection, the figure a measured slow success is compared with. */
const REFERENCE_FIRST_BYTE_MS = 30_000
/** A transfer is given this many times what its size needs at the route's declared rate. */
const TRANSFER_MARGIN = 4
/** What a body may go without a byte, written for a direct connection. */
export const DIRECT_STALL_MS = 10_000
/** Measured slowness raises a route's patience to this multiple of its declared floor at most. */
const MAX_WIDENING = 3
/** A wait follows the slowest first byte seen this recently, and this many times over. */
const EVIDENCE_KEPT_MS = 10 * 60_000
const EVIDENCE_MARGIN = 2.5
/** A route whose waits are stretched more than this many times is slow. */
const SLOW_SCALE = 2

export const DIRECT_PROFILE: RouteProfile = { id: 'direct', roundTripMs: REFERENCE_ROUND_TRIP_MS, coldStartMs: 0, bytesPerSecond: 1_000_000 }

/**
 * A route that is the Nym mixnet or a person's own SOCKS5 tunnel: measured against Nym, a fresh request reached its
 * first byte in about 3 s, one connection carried 15 to 40 KB a second, and a cold tunnel took up to 95 s to come up.
 */
export const TUNNEL_PROFILE: RouteProfile = { id: 'tunnel', roundTripMs: 3_000, coldStartMs: 95_000, bytesPerSecond: 20_000 }

export interface RoutePace {
  readonly id: string
  /** How many times a direct connection's wait this route waits: 1 for a direct connection. */
  scale: () => number
  /** `directMs`, a wait written for a direct connection, stretched for this route. */
  wait: (directMs: number) => number
  /** `wait`, plus what the route may still need to come up when it has carried nothing yet. */
  firstWait: (directMs: number) => number
  /** How long a body may go without a byte before the transfer counts as stalled. */
  stallMs: () => number
  /** The most a body of up to `bytes` may take once it has begun, a cap for a source that trickles for ever. */
  transferMs: (bytes: number) => number
  /** A request on this route got its first byte after `firstByteMs`: evidence for how patient the route needs to be. */
  observeFirstByte: (firstByteMs: number) => void
  /** Whether this route is much slower than a direct connection, so that work which competes with a person's page for it may be put off. */
  slow: () => boolean
}

/** A route that is as fast as the waits were written for: nothing stretches. */
export const DIRECT_ROUTE: RoutePace = {
  id: DIRECT_PROFILE.id,
  scale: () => 1,
  wait: (directMs) => directMs,
  firstWait: (directMs) => directMs,
  stallMs: () => DIRECT_STALL_MS,
  transferMs: (bytes) => DIRECT_STALL_MS + Math.ceil(bytes / DIRECT_PROFILE.bytesPerSecond) * 1000 * TRANSFER_MARGIN,
  observeFirstByte: () => {},
  slow: () => false
}

/** The longest `wait(directMs)` or `firstWait(directMs)` of a route with this `profile` can ever be, whatever it has measured: for a caller that cannot see the meter. */
export function ceilingWait (profile: RouteProfile, directMs: number): number {
  return Math.round(directMs * Math.max(1, profile.roundTripMs / REFERENCE_ROUND_TRIP_MS) * MAX_WIDENING) + profile.coldStartMs
}

/**
 * The patience of one route, kept by whoever makes requests over it. Starts at the route's declared floor; a first
 * byte that took long to arrive raises it (never above `MAX_WIDENING` times the floor), and it falls back as the
 * evidence ages. `markUp` ends the cold-start allowance.
 */
export class RouteMeter implements RoutePace {
  private up = false
  private readonly seen: Array<{ readonly at: number, readonly firstByteMs: number }> = []

  constructor (private readonly profile: RouteProfile, private readonly now: () => number = Date.now) {}

  get id (): string {
    return this.profile.id
  }

  /** The route carried a request: it is up. */
  markUp (): void {
    this.up = true
  }

  /** A request's first byte took `firstByteMs`, counted toward how slow this route has been lately. */
  observeFirstByte (firstByteMs: number): void {
    this.up = true
    const at = this.now()
    this.seen.push({ at, firstByteMs })
    this.forget(at)
  }

  private forget (at: number): void {
    while (this.seen.length > 0 && at - this.seen[0]!.at > EVIDENCE_KEPT_MS) this.seen.shift()
    if (this.seen.length > 32) this.seen.splice(0, this.seen.length - 32)
  }

  scale (): number {
    const floor = Math.max(1, this.profile.roundTripMs / REFERENCE_ROUND_TRIP_MS)
    this.forget(this.now())
    const slowest = this.seen.reduce((most, entry) => Math.max(most, entry.firstByteMs), 0)
    const measured = (EVIDENCE_MARGIN * slowest) / REFERENCE_FIRST_BYTE_MS
    return Math.min(Math.max(floor, measured), floor * MAX_WIDENING)
  }

  slow (): boolean {
    return this.scale() > SLOW_SCALE
  }

  wait (directMs: number): number {
    return Math.round(directMs * this.scale())
  }

  firstWait (directMs: number): number {
    return this.wait(directMs) + (this.up ? 0 : this.profile.coldStartMs)
  }

  stallMs (): number {
    return Math.round(DIRECT_STALL_MS * this.scale())
  }

  transferMs (bytes: number): number {
    return this.stallMs() + Math.ceil(bytes / this.profile.bytesPerSecond) * 1000 * TRANSFER_MARGIN
  }
}
