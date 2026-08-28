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
