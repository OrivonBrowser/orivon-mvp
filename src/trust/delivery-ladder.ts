// The delivery ladder (ADR-0006's D-ladder): how this app's code reached the
// machine, and how much that costs in ongoing trust. Pure, no I/O -- the
// caller supplies `now` rather than this file reading the clock, so a test
// (or a UI computing "how stale is this") never depends on when it runs.
//
// D1..D4 are ADR-0006's own rungs, unchanged:
//   D1 fetched from a host on every load (an ordinary website)      -- trust cost: continuous
//   D2 fetched once, cached, HASH-PINNED (TOFU on the bundle)       -- trust cost: once
//   D3 content-addressed (infohash / CID) -- the address IS the proof -- trust cost: none
//   D4 D3 AND the name is resolved trustlessly (ENS)                -- trust cost: none, deferred
//
// D4 IS UNREACHABLE BY EVERY INPUT THIS MVP CAN ACTUALLY PRODUCE TODAY, ON
// PURPOSE. ADR-0006 states plainly that trustless name resolution is
// deferred -- no such mechanism exists in this repository, so
// `nameResolvedTrustlessly` will only ever arrive `false` from any real
// caller right now. The field stays in the input type anyway: ADR-0006's own
// framing is that a later capability "adds cleanly" without invalidating
// anything already shipped, and a type that already has the field means the
// loader lane that eventually adds trustless resolution does not have to
// touch this file to make D4 reachable.

export type DeliveryRung = 'D1' | 'D2' | 'D3' | 'D4'

export type DeliveryMethod = 'fetched-each-load' | 'served-from-pinned-cache'

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
  /** Whether the app's own address is itself content-addressed (infohash/CID) rather than a DNS host -- D3/D4. */
  readonly addressIsContentAddressed: boolean
  /** Whether the human-readable name resolving to that address was itself resolved trustlessly (e.g. ENS) -- D4. See this file's header: unreachable today. */
  readonly nameResolvedTrustlessly: boolean
}

export interface DeliveryRungResult {
  readonly rung: DeliveryRung
  readonly met: boolean
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
}

export interface DeliveryLadderResult {
  /** All four rungs, always, each independently evaluated -- never a single label. */
  readonly rungs: readonly DeliveryRungResult[]
  readonly evidence: DeliveryEvidence
}

const ALL_RUNGS: readonly DeliveryRung[] = ['D1', 'D2', 'D3', 'D4']

function metRung (rung: DeliveryRung, evidence: DeliveryEvidence, input: DeliveryHistoryInput): boolean {
  switch (rung) {
    case 'D1':
      return input.deliveryMethod === 'fetched-each-load'
    case 'D2':
      return input.deliveryMethod === 'served-from-pinned-cache' && evidence.pinned && !evidence.pinMismatch
    case 'D3':
      return input.addressIsContentAddressed
    case 'D4':
      return input.addressIsContentAddressed && input.nameResolvedTrustlessly
  }
}

/** The delivery ladder for one app's fetch/pin history. See this file's header for D4's deliberate unreachability today. */
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
    nameResolvedTrustlessly: input.nameResolvedTrustlessly
  }

  const rungs = ALL_RUNGS.map((rung) => ({ rung, met: metRung(rung, evidence, input) }))

  return { rungs, evidence }
}
