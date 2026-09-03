// The connection-log input contract -- what a caller (eventually the broker,
// through wiring this lane does not do) hands this module to describe what an
// app has actually done. Defined HERE, not imported from src/broker/, per
// this directory's own README: "depend on the broker's connection log through
// a contract, never by reaching into broker internals." No real broker
// connection log exists yet (build step 2 assembled the broker; nothing wires
// per-app observation to it) -- this is the shape both sides are expected to
// meet at, not a transcription of something that already exists.
//
// COVERS THREE CAPABILITY SURFACES IN ONE ENTRY SHAPE, DELIBERATELY. A
// network connect, an `orivon.fs` operation and an `orivon.id` operation are
// different in almost every respect, but they are alike in the one respect
// this module cares about: each is a broker decision an app cannot see
// around. Splitting them into three entry types would force every consumer
// (the connection ladder, operation scoring) to merge three arrays back
// together to answer "what did this app do, in order" -- one shape, one
// `surface` discriminant, is what avoids that.
//
// BYTE COUNTS AND DURATION ARE HERE FOR A SPECIFIC REASON, not because the
// brief's own sketch of this shape listed them. ADR-0006's 2026-08-25
// amendment found the connection ladder was CHEAPER TO FAKE THAN TO EARN: an
// app exfiltrating a user's files by opening many short connections to many
// distinct hosts would classify as the best available grade, earned by the
// attack itself. The fix the owner accepted was byte accounting per endpoint
// and a byte-asymmetry signal (real swarm traffic is roughly symmetric;
// exfiltration is not) -- omitting bytesSent/bytesReceived/durationMs here
// would silently rebuild the exact bug ADR-0006 exists to prevent, one lane
// later. See connection-ladder.ts for where these are actually used.

import type { CapabilityKind, Pattern } from '../contracts/index.js'

/**
 * What became of one observed attempt. A closed union, not a boolean, for
 * the same reason connect.ts's ConnectDenialReason is closed: a UI has to be
 * able to tell "the broker refused this because of where it resolved" (T12)
 * apart from every other kind of refusal, and from "the broker allowed it
 * but the operation itself failed" -- three different facts a plain
 * allowed/denied boolean would collapse into one.
 */
export type ConnectionOutcome =
  /** The broker allowed the operation, and it completed. */
  | 'allowed'
  /**
   * The broker refused because the resolved address fell in a blocked range
   * (security-model.md T12) -- distinct from every other refusal because a
   * trust screen can say something concrete about it: the app tried to
   * reach an address the user's grant could never have covered.
   */
  | 'blocked-address-range'
  /** The broker refused for any other policy reason (no grant, quota, rate limit, malformed request, ...). */
  | 'blocked-policy'
  /** The broker allowed the operation, but it failed for a reason that was not a policy decision (e.g. the far end refused the TCP connection). */
  | 'error'

/**
 * One observed attempt through the broker -- a network connect, or an
 * `orivon.fs`/`orivon.id` operation. See this file's header for why all
 * three share one shape.
 */
export interface ConnectionLogEntry {
  /** Which capability surface this attempt went through. */
  readonly surface: CapabilityKind
  /**
   * The granted pattern this attempt matched, or `null` when the surface
   * carries no pattern concept (most `fs`/`id` operations) or the broker
   * denied the attempt before any pattern could match. Never the manifest's
   * DECLARED patterns, which may be far wider than what the user actually
   * granted (A18's precedent, followed by src/broker/policy/connect-src.ts).
   */
  readonly grantedPattern: Pattern | null
  /**
   * What the app asked for, surface-dependent: a `host:port` string for a
   * net surface, a path for `fs`, an identity label for `id`. Always a
   * plain string so a UI can display it verbatim without knowing the
   * surface first.
   */
  readonly target: string
  /**
   * The literal address actually dialed, once resolved -- T12's "checked
   * against resolved addresses, never the hostname" made observable. `null`
   * for `fs`/`id` surfaces, and for a net attempt the broker refused before
   * resolution happened.
   */
  readonly resolvedAddress: string | null
  readonly outcome: ConnectionOutcome
  /** Epoch milliseconds this attempt was observed. */
  readonly observedAt: number
  /**
   * Bytes sent/received over this attempt, when the surface carries a byte
   * stream. Undefined, not zero, when byte accounting was not available --
   * zero is a real observation (nothing was sent yet); undefined says
   * nothing was measured. See this file's header for why these exist.
   */
  readonly bytesSent?: number
  readonly bytesReceived?: number
  /** Milliseconds this attempt's connection stayed open, when known. */
  readonly durationMs?: number
}

/**
 * Why a grant pattern this app actually holds has no way to be reached
 * through ordinary `fetch`/WebSocket at all -- CSP's `connect-src` cannot
 * represent every pattern `orivon.net.connect` accepts
 * (open-questions.md A43). This is a SMALLER, CALLER-FACING vocabulary, not
 * a mirror of connect-src.ts's `ConnectSrcOmissionReason` -- that type
 * distinguishes reasons an app AUTHOR would need (a malformed pattern is
 * their bug to fix), which a trust screen showing a USER what broke has no
 * use for. Whoever wires the real broker connect-src derivation to this
 * module maps its reasons down to these.
 */
export type OmittedConnectReason =
  /** The grant covers more hosts than CSP's enumerable source list can name (e.g. "any public address"). */
  | 'unenumerable-hosts'
  /** The grant covers more ports than CSP's enumerable source list can name. */
  | 'unenumerable-ports'
  /** The pattern has no CSP token at all for a structural reason (e.g. an IPv6 literal, which CSP's host grammar cannot express). */
  | 'unrepresentable-address-form'
  /** Any other reason a granted pattern could not be turned into a CSP source. */
  | 'other'

/**
 * One granted pattern CSP could not represent. `pattern` is optional because
 * some omission reasons apply to the whole grant rather than to one pattern
 * (mirroring connect-src.ts's own `OmittedPattern.pattern`, which is
 * optional for the same reason) -- this module never needs to know which
 * those are, only that a pattern may be absent.
 */
export interface OmittedConnectPattern {
  readonly pattern: Pattern | null
  readonly reason: OmittedConnectReason
}

/**
 * Everything the connection ladder and operation scoring need about one
 * app's observed behaviour. `omittedConnectPatterns` is carried alongside
 * `entries`, not folded into them, because an omission is not something
 * that HAPPENED -- it is a standing fact about the grant ("this pattern can
 * never show up in `entries` even if the app tries it"), true for the whole
 * observation window rather than timestamped at one moment
 * (open-questions.md A43).
 */
export interface ConnectionLogInput {
  readonly entries: readonly ConnectionLogEntry[]
  readonly omittedConnectPatterns: readonly OmittedConnectPattern[]
}
