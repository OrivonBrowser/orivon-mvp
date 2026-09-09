// Picking a port pseudo-randomly across one or more granted ranges. Shared by
// ./udp-adapter.ts's bindUdp and ./node-adapters.ts's listenTcp -- pulled out
// once a second caller needed the exact same three functions
// (docs/development/code-guidelines.md Rule 3: the reason is shared, an
// ephemeral bind or listen must not fingerprint a session by always landing
// on the same port, open-questions.md A88 -- not just the shape).

import type { PortRange } from '../policy/bind.js'
import { fail } from '../errors.js'

/** Total ports across `ranges`, as a bound for randomStart's pick. */
export function countPorts (ranges: readonly PortRange[]): number {
  return ranges.reduce((total, range) => total + (range.hi - range.lo + 1), 0)
}

/**
 * A starting offset in `[0, total)` from the platform CSPRNG -- `Math.random`
 * is not required to be unpredictable, and this value's whole purpose is
 * being unpredictable across runs (A88).
 */
export function randomStart (total: number): number {
  const value = new Uint32Array(1)
  crypto.getRandomValues(value)
  return value[0]! % total
}

/** The `offset`-th port across `ranges`, treating them as one concatenated list. */
export function portAt (ranges: readonly PortRange[], offset: number): number {
  let remaining = offset
  for (const range of ranges) {
    const width = range.hi - range.lo + 1
    if (remaining < width) return range.lo + remaining
    remaining -= width
  }
  // Unreachable: callers take `offset` modulo countPorts(ranges).
  throw fail('internal', 'port offset outside the granted ranges')
}
