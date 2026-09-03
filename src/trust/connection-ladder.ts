// The connection ladder (ADR-0006's C-ladder): what an app has actually
// reached, built entirely from ConnectionLogInput. Pure, no I/O.
//
// THE SHAPE THIS FILE MUST NOT TAKE, per ADR-0006's 2026-08-25 amendment:
// a single pattern label ("swarm pattern") standing in for a verdict. That
// amendment exists because the ORIGINAL ladder was cheaper to fake than to
// earn -- an app exfiltrating a user's files by opening many short
// connections to many distinct hosts classified as the BEST available
// grade, earned by the attack itself. The fix the owner accepted: raw counts
// are the primary display, byte accounting per endpoint, and the one signal
// that is expensive to fake while actually exfiltrating -- volume sent to
// endpoints that sent little back, since a real swarm is roughly symmetric
// and exfiltration is not. `connectionLadder` below returns `evidence`
// (the raw counts) and `patternHeuristic` (the label, explicitly marked
// `basis: 'heuristic'`) together, in one object, on every path -- there is
// no exported function that returns the label alone.
//
// "CONTACTED ONLY HOSTS DECLARED IN ITS MANIFEST" (ADR-0006's original C2
// wording) IS STALE. A18 already resolved this one layer down
// (src/broker/policy/connect-src.ts derives CSP from GRANTED patterns, never
// the manifest's declared ones, because the manifest may be far wider than
// what the user actually approved). `allAllowedWereGranted` below follows
// that precedent: it asks whether every allowed net attempt matched a
// GRANTED pattern, never a declared one -- this module never sees the
// manifest at all, only ConnectionLogEntry.grantedPattern.

import type { ConnectionLogInput, ConnectionOutcome } from './connection-log.js'

export interface ConnectionEvidence {
  /** Distinct RESOLVED addresses the app successfully reached -- never counts a target string, and never counts an address a blocked-address-range attempt merely resolved to (T12: a blocked resolution is not a reach). */
  readonly distinctHostsContacted: number
  readonly totalAttempts: number
  readonly allowedAttempts: number
  /** Refused because the resolved address fell in a blocked range (T12). */
  readonly blockedAddressRangeAttempts: number
  /** Refused for any other policy reason. */
  readonly blockedPolicyAttempts: number
  /** Allowed by the broker, but the operation itself failed. */
  readonly errorAttempts: number
  readonly totalBytesSent: number
  readonly totalBytesReceived: number
  /** The longest `durationMs` seen across every entry, or `null` if none carried one. */
  readonly longestConnectionMs: number | null
  /**
   * True unless some ALLOWED attempt on a surface that carries a pattern
   * concept had no granted pattern. Entries with no pattern concept at all
   * (most `fs`/`id` operations) never count against this -- see this file's
   * header on why "declared" is not the word used here.
   */
  readonly allAllowedWereGranted: boolean
}

export type ConnectionPatternClass = 'single-server' | 'swarm' | 'mixed' | 'insufficient-data'

export interface ConnectionPatternHeuristic {
  readonly class: ConnectionPatternClass
  /** Always the literal `'heuristic'` -- so no caller can display this field as a verified fact without the type itself saying otherwise (ADR-0006's 2026-08-25 amendment). */
  readonly basis: 'heuristic'
  /**
   * Whether bytes sent and received are roughly balanced across the traffic
   * counted in `evidence` -- real swarm traffic is; exfiltration dressed up
   * as a swarm is not. `null` when no byte data was recorded at all: absence
   * of data is not evidence of symmetry, and must never be treated as if it
   * were.
   */
  readonly byteFlowSymmetric: boolean | null
}

export interface ConnectionLadderResult {
  readonly evidence: ConnectionEvidence
  readonly patternHeuristic: ConnectionPatternHeuristic
  readonly omittedConnectPatterns: ConnectionLogInput['omittedConnectPatterns']
}

// Neither constant is specified anywhere in the corpus -- AI-RECOMMENDED,
// not an owner decision, same disclosure connect-src.ts's MAX_ENUMERATED_PORTS
// makes for the same reason (an unspecified threshold this file cannot avoid
// choosing). SINGLE_SERVER_MAX_HOSTS is deliberately small: the ladder's
// point is to distinguish "talks to a handful of stable endpoints" from
// "talks to many peers", and picking a number close to SWARM_MIN_HOSTS would
// leave a wide "mixed" band that never resolves anything.
const SINGLE_SERVER_MAX_HOSTS = 2
const SWARM_MIN_HOSTS = 5
// "Roughly symmetric" (ADR-0006's own words) is read as: the smaller of
// sent/received is at least half the larger. Picked to tolerate ordinary
// protocol overhead (headers, acks) without accepting the exfiltration shape
// the amendment names -- ten sent for every one received.
const SYMMETRY_RATIO_FLOOR = 0.5

function hasPatternConcept (surface: ConnectionLogInput['entries'][number]['surface']): boolean {
  return surface !== 'fs' && surface !== 'id'
}

function computeEvidence (entries: ConnectionLogInput['entries']): ConnectionEvidence {
  const hosts = new Set<string>()
  const byOutcome: Record<ConnectionOutcome, number> = {
    allowed: 0,
    'blocked-address-range': 0,
    'blocked-policy': 0,
    error: 0
  }
  let totalBytesSent = 0
  let totalBytesReceived = 0
  let longestConnectionMs: number | null = null
  let allAllowedWereGranted = true

  for (const e of entries) {
    byOutcome[e.outcome] += 1
    totalBytesSent += e.bytesSent ?? 0
    totalBytesReceived += e.bytesReceived ?? 0
    if (e.durationMs !== undefined && (longestConnectionMs === null || e.durationMs > longestConnectionMs)) {
      longestConnectionMs = e.durationMs
    }

    // Only a successfully ALLOWED attempt counts as a host "contacted" --
    // a blocked-address-range attempt resolved somewhere, but T12 means the
    // app never actually reached it.
    if (e.outcome === 'allowed' && e.resolvedAddress !== null) hosts.add(e.resolvedAddress)

    if (e.outcome === 'allowed' && hasPatternConcept(e.surface) && e.grantedPattern === null) {
      allAllowedWereGranted = false
    }
  }

  return {
    distinctHostsContacted: hosts.size,
    totalAttempts: entries.length,
    allowedAttempts: byOutcome.allowed,
    blockedAddressRangeAttempts: byOutcome['blocked-address-range'],
    blockedPolicyAttempts: byOutcome['blocked-policy'],
    errorAttempts: byOutcome.error,
    totalBytesSent,
    totalBytesReceived,
    longestConnectionMs,
    allAllowedWereGranted
  }
}

function byteFlowSymmetric (sent: number, received: number): boolean | null {
  if (sent === 0 && received === 0) return null
  const larger = Math.max(sent, received)
  const smaller = Math.min(sent, received)
  if (larger === 0) return true
  return smaller / larger >= SYMMETRY_RATIO_FLOOR
}

function classify (evidence: ConnectionEvidence, symmetric: boolean | null): ConnectionPatternClass {
  if (evidence.allowedAttempts === 0) return 'insufficient-data'
  if (evidence.distinctHostsContacted <= SINGLE_SERVER_MAX_HOSTS) return 'single-server'
  if (evidence.distinctHostsContacted >= SWARM_MIN_HOSTS && symmetric === true) return 'swarm'
  return 'mixed'
}

/** The connection ladder for one app's observed activity. See this file's header for the shape it deliberately never takes. */
export function connectionLadder (input: ConnectionLogInput): ConnectionLadderResult {
  const evidence = computeEvidence(input.entries)
  const symmetric = byteFlowSymmetric(evidence.totalBytesSent, evidence.totalBytesReceived)
  return {
    evidence,
    patternHeuristic: {
      class: classify(evidence, symmetric),
      basis: 'heuristic',
      byteFlowSymmetric: symmetric
    },
    omittedConnectPatterns: input.omittedConnectPatterns
  }
}
