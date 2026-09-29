// The named error every `fs` `*Sync` refusal throws -- same pattern as
// http/unsupported.ts's own gaps. Every `fs` `*Sync` export now works in a
// Worker of a cross-origin isolated app (fs/core-sync.ts, ADR-0016's
// amendment, over the Worker's synchronous twin, sync-orivon.ts's `syncFs`)
// and throws this same error only on the page, or in a Worker with no
// SharedArrayBuffer -- `syncFs()` itself is the one place that throws it,
// not a per-export helper here.

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
