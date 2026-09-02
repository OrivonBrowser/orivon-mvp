// The concrete OrivonError, moved unchanged out of ./handles.ts (that file's
// own note asked for this) so it can be shared by every broker module that
// throws one instead of each defining its own copy.

import type { OrivonError, OrivonErrorCode } from '../contracts/index.js'

/**
 * The concrete OrivonError. src/contracts/ declares it as an interface because
 * that directory emits no runtime code; somebody has to construct it.
 *
 * No `platformCode` is ever set here. This module never touches a real socket
 * so it has no errno to report, and 'denied' must never carry one in any case
 * (a denial that varied by reason turns the permission boundary itself into a
 * probe target).
 */
class BrokerError extends Error implements OrivonError {
  readonly code: OrivonErrorCode
  readonly handleId?: string
  readonly platformCode?: string

  constructor (code: OrivonErrorCode, message: string, handleId?: string, platformCode?: string) {
    super(message)
    this.name = 'OrivonError'
    this.code = code
    // exactOptionalPropertyTypes: assigning `undefined` to an optional field is
    // not the same as leaving it absent, and `handleId` must be absent.
    if (handleId !== undefined) this.handleId = handleId
    // 'denied' is uniform across every reason for denial and must never carry
    // a platformCode. Enforced here rather than trusted to every call site,
    // because a single leak turns the permission boundary into a probe target.
    if (platformCode !== undefined && code !== 'denied') this.platformCode = platformCode
  }
}

export function fail (code: OrivonErrorCode, message: string, handleId?: string, platformCode?: string): OrivonError {
  return new BrokerError(code, message, handleId, platformCode)
}

/** Every value OrivonErrorCode actually has -- see contracts/errors.ts. */
const ORIVON_ERROR_CODES: ReadonlySet<OrivonErrorCode> = new Set<OrivonErrorCode>([
  'denied', 'revoked', 'unreachable', 'timeout', 'reset', 'closed', 'limit', 'invalid', 'notFound', 'exists', 'internal'
])

/**
 * Recognises an error this broker (or an adapter constructing one the same
 * way) already produced, as opposed to something still raw from an injected
 * dependency. Shared by ./ipc.ts (mapping a thrown value to a
 * ResponseEnvelope) and ./node-adapters.ts (dialTcp's own fallback).
 *
 * ./index.ts has a private, stricter variant that also demands
 * `.name === 'OrivonError'`, so the two disagree about an error an adapter
 * built with a valid code but a different name. Consolidating them is a
 * behavioural decision, not a move -- open-questions.md A39.
 */
export function isOrivonErrorLike (value: unknown): value is OrivonError {
  return value instanceof Error && 'code' in value &&
    ORIVON_ERROR_CODES.has((value as { code: OrivonErrorCode }).code)
}

/**
 * The raw errno string off a thrown value, if it carries one. Node's own
 * convention is an `Error` with a `.code` string, but this deliberately
 * accepts any object: the broker reaches the network and filesystem through
 * injected dependencies, so what arrives here is as often a test stub's plain
 * object as a real Node error, and both carry `.code` alike.
 *
 * A non-string `.code` is ignored rather than coerced, which matters in both
 * directions. Node puts the numeric form on `.errno` and never on `.code`, so
 * a number here is not an errno to begin with; and coercing would turn a
 * present-but-undefined `code` into the string "undefined" and hand a caller's
 * errno table something to look up.
 */
export function errnoOf (error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}
