// The one `fs` gap this shim does not close, named rather than faked --
// same pattern as node-http-unsupported.ts's own gaps.
//
// SYNC BEYOND readFileSync: capability-api.ts's design rule 2 (ADR-0016)
// grants exactly one synchronous fs call. `fs.statSync` has a real,
// unguessed caller -- fs-chunk-store and webtorrent's own torrent.js both
// call it at module load time, wrapped in a try/catch that already exists
// to handle a real ENOENT the same way (`TMP = path.join(fs.statSync('/tmp')
// ..., 'webtorrent')`, caught, falling back to os.tmpdir()). Throwing here
// composes with that existing guard instead of needing a new one.

import { OrivonShimError } from './errors.js'

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

/** Every synchronous fs export except readFileSync -- ADR-0016 grants no other one. Accepts any arguments (real callers pass a path, options, ...) since it always throws regardless. */
export function syncUnsupported (api: string): (...args: readonly unknown[]) => never {
  return (..._args: readonly unknown[]) => {
    throw new OrivonFsUnsupportedError(
      api,
      'orivon.fs has exactly one synchronous call, readFileSync (ADR-0016) -- this is not it. ' +
      'Use the async form instead.',
      'ERR_ORIVON_FS_SYNC_UNSUPPORTED'
    )
  }
}
