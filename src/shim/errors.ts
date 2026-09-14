// One error type for a member src/shim/'s modules refuse by name rather than
// leaving it absent (A135) -- the Node-stdlib sibling of
// src/shim-electron/errors.ts's ElectronShimError. A deliberate SECOND
// class, not a shared one: the reasons a Node-stdlib gap names are not the
// reasons an Electron desktop-shell gap names (see unimplemented.ts and
// README.md's Design notes for the full reasoning).

/** Closed union: every reason src/shim/'s modules ever decline a member by name instead of leaving it absent. */
export type ShimRefusalReason =
  /** Real Node surface nothing has decided whether this shim will ever build (compatibility-matrix.md Table 3's `dup` rows, prose only -- no cell tracks individual members). */
  | 'unimplemented'
  /** A decision is on record and a build path is named (e.g. dns.lookup's D-0006, net.listen's A114), but the broker or this shim does not implement it yet. */
  | 'not-built'
  /** Excluded by design -- an owner policy row (compatibility-matrix.md Table 1's 🚫 rows), not a gap. */
  | 'excluded'
  /** Real Node has this because of a runtime concept (event-loop handles, POSIX uid/gid bits) with no Orivon equivalent -- a substrate difference, not a capability gap. */
  | 'not-applicable'

export class OrivonShimError extends Error {
  readonly api: string
  readonly reason: ShimRefusalReason

  constructor (api: string, reason: ShimRefusalReason, message: string) {
    super(`orivon-node-shim: ${message}`)
    this.name = 'OrivonShimError'
    this.api = api
    this.reason = reason
  }
}

/** Builds (does not throw) an OrivonShimError -- callers write `throw refuseShim(...)` so a function's return type can stay `never` at the call site. */
export function refuseShim (api: string, reason: ShimRefusalReason, message: string): OrivonShimError {
  return new OrivonShimError(api, reason, message)
}
