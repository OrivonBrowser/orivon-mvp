// The one `fs` gap this shim does not close everywhere, named rather than
// faked -- same pattern as http/unsupported.ts's own gaps. `syncUnsupported`
// itself is now only realpathSync's (fs/fs.ts): every other *Sync export
// this shim once refused unconditionally now works in a Worker of a
// cross-origin isolated app (fs/core-sync.ts, ADR-0016's amendment) and
// throws this same error only on the page, or in a Worker with no
// SharedArrayBuffer.

import { OrivonShimError } from '../errors.js'

// A177's FOURTH instance, closed here. This class was added after the branch
// that fixed the other three was written, so it reintroduced the same gap:
// extending bare Error meant `catch (e) { if (e instanceof OrivonShimError) }`
// -- the check a ported app writes once for the whole shim -- silently missed
// every fs refusal. Message, name and both codes are unchanged; only the
// base class moves, so nothing a caller already matches on shifts.
export class OrivonFsUnsupportedError extends OrivonShimError {
  readonly code: string

  constructor (api: string, reason: string, code = 'ERR_ORIVON_FS_UNSUPPORTED') {
    super(api, 'not-built', `${api} is not supported -- ${reason}`)
    this.name = 'OrivonFsUnsupportedError'
    this.code = code
  }
}

/** realpathSync: the one *Sync export with no async core to build over (fs/core-sync.ts's own header says why). Accepts any arguments (real callers pass a path, options, ...) since it always throws regardless. */
export function syncUnsupported (api: string): (...args: readonly unknown[]) => never {
  return (..._args: readonly unknown[]) => {
    throw new OrivonFsUnsupportedError(
      api,
      `${api} has no synchronous form anywhere: use the async form instead.`,
      'ERR_ORIVON_FS_SYNC_UNSUPPORTED'
    )
  }
}
