// The one OrivonError constructor for src/broker/policy/, consolidated out of
// four byte-identical copies (derive.ts, derive-encoding.ts, bundle-hash.ts,
// pin.ts) -- docs/development/code-guidelines.md Rule 3.
//
// Distinct from src/broker/errors.ts's BrokerError: that one is a class
// enforcing the platformCode/'denied' invariant for the stateful handle-table
// layer. This directory is pure by structural rule and has no engine error to
// report, so a plain Object.assign is the whole of what's needed here.

import type { OrivonError, OrivonErrorCode } from '../../contracts/index.js'

/**
 * OrivonError is an interface, not a class -- src/contracts/ emits no
 * runtime code (contracts/errors.ts). Something in this pure layer has to
 * construct the concrete object; callers only ever switch on `code`.
 *
 * No `platformCode`: errors.ts describes it as the underlying engine's own
 * detail (a Node errno, later a WASI code). Nothing underneath failed here --
 * these are policy-layer rejections with no engine error to report -- and
 * inventing one would make an app's fallback logic branch on fiction.
 */
export function fail (code: OrivonErrorCode, message: string): OrivonError {
  return Object.assign(new Error(message), { code })
}
