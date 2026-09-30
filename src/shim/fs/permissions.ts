// chmod and lchmod. orivon.fs has no mode to set (README.md's Design notes),
// so each succeeds after the check that matters to a caller: the path exists
// and is inside the app's files. A library that tightens a directory on first
// start (`chmod 0700`) then runs; what it asked for is not stored, and stat
// reports the fixed mode stats.ts documents. chown stays refused by name.

import { doAccess } from './core.js'
import { assertMode, fsError, type PathLike } from './paths.js'
import type { NodeCallback } from './handle.js'

export async function doChmod (path: PathLike, mode: unknown): Promise<void> {
  assertMode(mode)
  await doAccess(path)
}

export function chmod (path: PathLike, mode: unknown, callback: NodeCallback<void>): void {
  assertMode(mode)
  doAccess(path).then(() => callback(null), (error) => callback(error as Error))
}

export const lchmod = chmod

/** `exists` is the caller's existence check: fs.existsSync, which works on a page too. */
export function chmodSyncWith (exists: (path: PathLike) => boolean, path: PathLike, mode: unknown): void {
  assertMode(mode)
  if (!exists(path)) throw fsError('ENOENT', 'no such file or directory', 'chmod', typeof path === 'string' ? path : String(path))
}
