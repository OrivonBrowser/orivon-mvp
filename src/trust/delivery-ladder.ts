// The delivery ladder (ADR-0006's D-ladder): how trustless the connection
// that delivered this app's code is, on the canonical Web3 scores page's own
// Connection-to-network scale. Pure, no I/O -- the caller supplies `now`
// rather than this file reading the clock, so a test (or a UI computing "how
// stale is this") never depends on when it runs.
//
// Three levels, matching the canonical page exactly (never renamed to
// "Connection" in this codebase's own UI: `src/trust/connection-ladder.ts`
// already owns that word, for the unrelated, still-unwired per-app
// network-log axis -- see this directory's own README):
//   D1  relies on a trusted, centralised party for the bytes           -- red
//   D2  a `.eth` name proven trustlessly AND its content addressed by  -- yellow
//       CID, so every byte is checked against something no single host
//       can rewrite
//   D3  trustless for data availability -- nothing in this build fetches
//       peer-to-peer, so no automatic path reaches it; a developer-only
//       override can, for previewing the UI (`../main/dev/score-levels.ts`)
//
// A TOFU-pinned installed app (hash-pinned, trusted the first time) and a
// CID reached through an unproven DNSLink both stay D1: the pin and the
// DNSLink record are each trusted once, from a single source, never proven
// trustless. Neither fact is lost -- both stay visible as evidence (the pin
// block, the name-evidence line) beside this level, never folded into it.

export type DeliveryLevel = 1 | 2 | 3

export type DeliveryMethod = 'fetched-each-load' | 'served-from-pinned-cache'

/**
 * How much of what this app's page loaded this session came from its own
 * hash-verified pin versus a granted third-party host (owner's framing,
 * 2026-09-15: fetching third-party code is not a violation the pin fails to
 * catch -- the pin still proves the app's OWN bytes are unaltered -- but it
 * costs trust score, and the level alone does not say by how much). Passed
 * through into `DeliveryEvidence.pinCoverage` verbatim -- the level does not
 * read it, the same "evidence, not a verdict" stance connection-ladder.ts
 * already takes for its own pattern heuristic (this scores nothing; see
 * build step 7 for how it renders). Structurally identical to
 * src/loader/serve/pin-coverage.ts's `PinCoverageSnapshot`, defined
 * separately rather than imported from it -- this directory's README: never
 * reach into another stream's internals.
 */
export interface PinCoverageEvidence {
  readonly pinnedRequests: number
  readonly thirdPartyRequests: number
  readonly deniedRequests: number
  readonly pinnedBytes: number
  readonly thirdPartyBytes: number
  /** True once some counted request's byte size could not be measured -- the byte totals above are a floor, not exact, from that point on. */
  readonly bytesIncomplete: boolean
}

/**
 * What a caller (eventually the loader, which owns pinning -- ADR-0005,
 * ADR-0009) knows about this app's delivery history. Defined locally, not
 * imported from src/broker/'s `PinRecord` -- this module's own README says
 * never import broker internals, and this shape is deliberately narrower:
 * a UI-facing set of facts, not the on-disk pin record's full schema.
 */
export interface DeliveryHistoryInput {
  /** Whether this app has ever been pinned before this load. */
  readonly everPinned: boolean
  /** Epoch ms the pin now in effect was first written, or `null` if never pinned. */
  readonly pinnedAt: number | null
  /** "Now", supplied by the caller so pin age is reproducible and testable. */
  readonly now: number
  readonly deliveryMethod: DeliveryMethod
  /**
   * Whether the bundle just fetched matches the pinned hash. `null` when
   * there is no pin to compare against (first install, or `deliveryMethod`
   * is `'fetched-each-load'` and no pin exists at all) -- distinct from
   * `false`, which means a pin EXISTS and the current fetch does not match
   * it, a fact worth its own flag (see `pinMismatch` below).
   */
  readonly currentFetchMatchesPin: boolean | null
  /** Whether the pinned hash has ever changed since this app was first installed (an accepted, re-consented update). */
  readonly pinHasChanged: boolean
  /** Whether the app's own address is itself content-addressed (infohash/CID) rather than a DNS host. */
  readonly addressIsContentAddressed: boolean
  /** Whether the human-readable name resolving to that address was itself resolved trustlessly (e.g. ENS). */
  readonly nameResolvedTrustlessly: boolean
  /** This app's pin-coverage for the current session, or `undefined` when the caller has none to report (no request observed yet, or nothing wired it up). Passed through into `DeliveryEvidence.pinCoverage` unchanged -- see `PinCoverageEvidence`'s own doc. */
  readonly pinCoverage?: PinCoverageEvidence
}

export interface DeliveryEvidence {
  readonly pinned: boolean
  /** `now - pinnedAt`, or `null` if never pinned. */
  readonly pinAgeMs: number | null
  readonly pinHasChanged: boolean
  readonly currentFetchMatchesPin: boolean | null
  /**
   * True exactly when a pin exists and the current fetch does not match it
   * -- an anomaly worth its own flag rather than leaving a UI to notice
   * `pinned && currentFetchMatchesPin === false` on its own. Stated as a
   * fact, not a verdict: this module does not decide how alarming that is.
   */
  readonly pinMismatch: boolean
  readonly deliveryMethod: DeliveryMethod
  readonly addressIsContentAddressed: boolean
  readonly nameResolvedTrustlessly: boolean
  /** `input.pinCoverage`, unchanged -- see that field's own doc. */
  readonly pinCoverage: PinCoverageEvidence | undefined
}

export interface DeliveryLadderResult {
  readonly level: DeliveryLevel
  readonly evidence: DeliveryEvidence
}

/** D2 is met only by a `.eth` name proven trustlessly, its content itself
 * content-addressed -- the strict canonical reading the owner chose: a
 * TOFU-pinned app and an unproven DNSLink CID both stay D1, since each is
 * trusted from a single source rather than proven. Nothing here can reach
 * D3: no automatic path in this build fetches peer-to-peer. */
function level (input: DeliveryHistoryInput): DeliveryLevel {
  return input.addressIsContentAddressed && input.nameResolvedTrustlessly ? 2 : 1
}

/** The delivery ladder for one app's fetch/pin history. */
export function deliveryLadder (input: DeliveryHistoryInput): DeliveryLadderResult {
  const pinMismatch = input.everPinned && input.currentFetchMatchesPin === false

  const evidence: DeliveryEvidence = {
    pinned: input.everPinned,
    pinAgeMs: input.pinnedAt === null ? null : input.now - input.pinnedAt,
    pinHasChanged: input.pinHasChanged,
    currentFetchMatchesPin: input.currentFetchMatchesPin,
    pinMismatch,
    deliveryMethod: input.deliveryMethod,
    addressIsContentAddressed: input.addressIsContentAddressed,
    nameResolvedTrustlessly: input.nameResolvedTrustlessly,
    pinCoverage: input.pinCoverage
  }

  return { level: level(input), evidence }
}
