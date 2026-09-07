// Capability checking for `udp.bind` (and, when it is built, `tcp.listen`).
// The sibling of ./connect.ts -- see ./README.md, Design notes, for why the
// two are separate functions rather than one with a mode flag.
//
// TWO TRAPS FOR WHOEVER EDITS BELOW, both the opposite of what ./connect.ts
// does, so reading that file first is actively misleading here:
//
//   `"*"` IS REJECTED, and ports below 1024 are denied outright
//   (capability-api.md A9 SS1). In `connect` a `*:*` grant is legitimate and
//   443 must work; a bind opens a service, and neither holds.
//
// Every denial reason below is LOCAL LOG ONLY and must never reach the app,
// exactly as ./connect.ts's is: `code` is always a bare 'denied'.
import type { OrivonErrorCode, Pattern } from '../../contracts/index.js'
import { MAX_PORT, MIN_UNPRIVILEGED_PORT } from './canonical-host.js'
import { parsePortSpec } from './connect-patterns.js'
import { MAX_PATTERNS } from './connect.js'

/** An inclusive port range. `lo === hi` for a single port. */
export interface PortRange {
  readonly lo: number
  readonly hi: number
}

/**
 * Why a bind was refused. FOR THE BROKER'S LOCAL LOG ONLY, same rule as
 * ConnectDenialReason -- a denial that varied by reason on the wire would let
 * an app map exactly which ports its grant excludes.
 *
 * The three `*-pattern` reasons are worth distinguishing precisely because
 * they should be UNREACHABLE: `src/loader/manifest-capabilities.ts` rejects
 * all three at manifest-parse time, so one arriving here means a corrupt
 * ledger or a grant path that skipped validation. Logging which one is how
 * that gets noticed.
 */
export type BindDenialReason =
  /** No granted patterns, or an empty list. Absence means absence. */
  | 'not-declared'
  /** More patterns than MAX_PATTERNS. Fail closed rather than scan them. */
  | 'too-many-patterns'
  /** `port` was not an integer in 0..65535. 0 is legal here -- it means ephemeral. */
  | 'bad-port'
  /** The REQUESTED port is privileged. */
  | 'privileged-port'
  /** A granted pattern was `"*"`, which would authorise every port. */
  | 'wildcard-pattern'
  /** A granted range reached below 1024. */
  | 'privileged-pattern'
  /** A granted pattern was not a readable port or port range. */
  | 'unparseable-pattern'
  /** Patterns were usable; none of them covers this port. */
  | 'no-pattern-match'

export interface BindAllowed {
  readonly allowed: true
  /**
   * BIND INSIDE ONE OF THESE, and nowhere else.
   *
   * Never empty, and every entry has `lo >= MIN_UNPRIVILEGED_PORT`. For an
   * explicit port this is the single port asked for, narrowed to `lo === hi`,
   * so a caller cannot drift from the port that was actually checked. For the
   * ephemeral case it is every granted range that survived, in declaration
   * order -- the caller picks a free port from them and fails if none is free.
   */
  readonly ranges: readonly PortRange[]
}

export interface BindDenied {
  readonly allowed: false
  /** Always 'denied'. Typed through OrivonErrorCode so a rename breaks the build. */
  readonly code: Extract<OrivonErrorCode, 'denied'>
  /** LOCAL LOG ONLY. Never send this, or anything derived from it, to an app. */
  readonly reason: BindDenialReason
}

export type BindDecision = BindAllowed | BindDenied

function deny (reason: BindDenialReason): BindDenied {
  return { allowed: false, code: 'denied', reason }
}

/**
 * Decides whether `patterns` -- the GRANTED pattern list, never the manifest's
 * declared one (./connect.ts's header, and docs/open-questions.md A18) --
 * authorises binding `port`.
 *
 * `port` of 0 means "any free port the OS picks"; see BindAllowed.ranges for
 * what the caller gets back and why it is ranges rather than a yes.
 *
 * Never throws on its own account, including on a `patterns` that is not an
 * array: GrantLedger rehydrates persisted grants from JSON, so the type
 * signature is a compile-time promise and not a runtime one.
 */
export function checkBind (patterns: readonly Pattern[], port: number): BindDecision {
  if (!Array.isArray(patterns)) return deny('not-declared')
  if (patterns.length === 0) return deny('not-declared')
  if (patterns.length > MAX_PATTERNS) return deny('too-many-patterns')

  if (!Number.isInteger(port) || port < 0 || port > MAX_PORT) return deny('bad-port')
  if (port !== 0 && port < MIN_UNPRIVILEGED_PORT) return deny('privileged-port')

  const usable: PortRange[] = []
  // The FIRST structural problem seen, reported only if nothing usable
  // survives. A good pattern beside a bad one still authorises -- matching
  // ./connect.ts, where an unreadable pattern authorises nothing rather than
  // poisoning the whole grant.
  let problem: BindDenialReason | undefined

  for (const pattern of patterns) {
    if (typeof pattern !== 'string') {
      problem ??= 'unparseable-pattern'
      continue
    }
    const spec = parsePortSpec(pattern.trim())
    if (spec === null) {
      problem ??= 'unparseable-pattern'
      continue
    }
    if (spec === 'any') {
      problem ??= 'wildcard-pattern'
      continue
    }
    // NOT CLAMPED to the unprivileged part. Clamping would turn a grant nobody
    // could have approved into a narrower one they also did not approve; the
    // whole pattern is discarded instead.
    if (spec.lo < MIN_UNPRIVILEGED_PORT) {
      problem ??= 'privileged-pattern'
      continue
    }
    usable.push({ lo: spec.lo, hi: spec.hi })
  }

  if (usable.length === 0) return deny(problem ?? 'no-pattern-match')
  if (port === 0) return { allowed: true, ranges: usable }

  const covered = usable.some((range) => port >= range.lo && port <= range.hi)
  return covered ? { allowed: true, ranges: [{ lo: port, hi: port }] } : deny('no-pattern-match')
}
