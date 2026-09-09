// One error type for every API this package refuses or cannot yet back, so a
// porting developer's catch block sees a named reason instead of a generic
// TypeError from a missing property. See README.md's Design notes for why a
// single closed reason union, rather than one class per refusal, was chosen.

/** Closed union: every reason this shim ever declines to do something. */
export type ElectronShimReason =
  /** `BrowserWindow`/`Menu`/`Tray` -- the desktop-shell row, out of scope by design (compatibility-matrix.md Table 2). */
  | 'desktop-shell'
  /** A named path Electron's real `app.getPath` backs with a host directory Orivon has no route to (Table 3: ambient FS excluded by design). */
  | 'ambient-fs'
  /** Spec'd in `capability-api.ts` but the broker does not implement it yet (Table 1). */
  | 'not-built'
  /** A synchronous accessor called before `app.whenReady()` resolved. */
  | 'not-ready'
  /** Anything else this package does not implement at all. */
  | 'unimplemented'
  /** Called in a way real Electron itself rejects (e.g. a duplicate `ipcMain.handle`). */
  | 'invalid-usage'

export class ElectronShimError extends Error {
  readonly api: string
  readonly reason: ElectronShimReason

  constructor (api: string, reason: ElectronShimReason, message: string) {
    super(message)
    this.name = 'ElectronShimError'
    this.api = api
    this.reason = reason
  }
}

/** Builds (does not throw) an ElectronShimError -- callers write `throw refuse(...)` so a function's return type can stay `never` at the call site. */
export function refuse (api: string, reason: ElectronShimReason, message: string): ElectronShimError {
  return new ElectronShimError(api, reason, message)
}
