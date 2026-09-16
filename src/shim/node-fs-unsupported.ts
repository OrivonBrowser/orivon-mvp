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

export class OrivonFsUnsupportedError extends Error {
  readonly code: string

  constructor (api: string, reason: string, code = 'ERR_ORIVON_FS_UNSUPPORTED') {
    super(`orivon-node-shim: ${api} is not supported -- ${reason}`)
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
