// Per-origin, per-session pin coverage (ADR-0006's D-ladder, reframed
// 2026-09-15): how much of what this app's page actually loaded came from
// its own hash-verified pin versus a granted third-party host. Fetching
// third-party code is not a violation -- the pin still proves the app's OWN
// bytes are unaltered -- but it costs trust score, and nothing measured it
// before this. serve.ts's request handler is the one place that sees every
// outcome (a pinned asset served, a third-party request proxied, or a
// refusal), so it records here.
//
// COUNTED, NEVER LOGGED. Only running totals -- never which third-party host
// was reached, never a per-request history. In memory only, discarded with
// the tracker that owns it. This is deliberately not browsing history.
//
// BYTES ARE READ, NEVER MEASURED BY BUFFERING. A pinned asset's size is
// already known (the bytes are in hand to serve it). A third-party
// response's size is read from its own `content-length` header when the
// peer sent one -- reading a header already present costs nothing, but the
// body itself is never consumed just to size it (reach/reach.ts streams it
// on purpose). A missing size sets `bytesIncomplete`, never a silent zero.

export type PinCoverageOutcome = 'pinned' | 'third-party' | 'denied'

export interface PinCoverageSnapshot {
  readonly pinnedRequests: number
  readonly thirdPartyRequests: number
  readonly deniedRequests: number
  readonly pinnedBytes: number
  readonly thirdPartyBytes: number
  /** True once some pinned or third-party request's byte size could not be measured -- the byte totals above are a floor, not exact, from that point on. */
  readonly bytesIncomplete: boolean
}

export interface PinCoverageTracker {
  /** Records one request's outcome. `bytes` is the response body size when known -- omit it (not zero) when it was never measured. */
  record: (outcome: PinCoverageOutcome, bytes?: number) => void
  /** The running totals so far, as a fresh object each call. */
  snapshot: () => PinCoverageSnapshot
}

/**
 * A fresh, empty tracker. One per origin's serving registration
 * (electron/serve.ts's `registerServingFor`), so re-registering an origin
 * (a reinstall, within the same process run) starts a new session's counts
 * rather than carrying the old one forward.
 */
export function createPinCoverageTracker (): PinCoverageTracker {
  let pinnedRequests = 0
  let thirdPartyRequests = 0
  let deniedRequests = 0
  let pinnedBytes = 0
  let thirdPartyBytes = 0
  let bytesIncomplete = false

  return {
    record (outcome, bytes) {
      if (outcome === 'denied') {
        deniedRequests += 1
        return
      }
      if (outcome === 'pinned') pinnedRequests += 1
      else thirdPartyRequests += 1

      if (bytes === undefined) {
        bytesIncomplete = true
        return
      }
      if (outcome === 'pinned') pinnedBytes += bytes
      else thirdPartyBytes += bytes
    },
    snapshot () {
      return { pinnedRequests, thirdPartyRequests, deniedRequests, pinnedBytes, thirdPartyBytes, bytesIncomplete }
    }
  }
}
