// The two `fs` gaps this queue item does not close, named rather than faked
// -- same pattern as node-http-unsupported.ts and node-net-unsupported.ts.
//
// SYNC BEYOND readFileSync: capability-api.ts's design rule 2 (ADR-0016)
// grants exactly one synchronous fs call. `fs.statSync` has a real,
// unguessed caller -- fs-chunk-store and webtorrent's own torrent.js both
// call it at module load time, wrapped in a try/catch that already exists
// to handle a real ENOENT the same way (`TMP = path.join(fs.statSync('/tmp')
// ..., 'webtorrent')`, caught, falling back to os.tmpdir()). Throwing here
// composes with that existing guard instead of needing a new one.
//
// fs.open/FileHandle: not built at the broker at all (PR #132 parked it
// deliberately) -- see handle-contracts.md's FileHandle section.

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

/** fs.open / fs.promises.open -- no FileHandle capability exists at the broker yet. Accepts any arguments (path, flags, callback, ...) since it always throws regardless. */
export function open (..._args: readonly unknown[]): never {
  throw new OrivonFsUnsupportedError(
    'fs.open',
    'no FileHandle capability exists at the broker yet -- see docs/architecture/handle-contracts.md\'s ' +
    'FileHandle section. Use fs.readFile/writeFile for whole-file access instead.',
    'ERR_ORIVON_FS_OPEN_UNSUPPORTED'
  )
}
