// chmod and lchmod. orivon.fs has no mode to set (README.md's Design notes),
// so each succeeds after the check that matters to a caller: the path exists
// and is inside the app's files. A library that tightens a directory on first
// start (`chmod 0700`) then runs; what it asked for is not stored, and stat
// reports the fixed mode stats.ts documents. chown stays refused by name.

import { doAccess } from './core.js'
import { assertMode, confineSync, fsError, type PathLike } from './paths.js'
import type { NodeCallback } from './handle.js'

export async function doChmod (path: PathLike, mode: unknown): Promise<void> {
  assertMode(mode)
  await doAccess(path, 'chmod')
}

export function chmod (path: PathLike, mode: unknown, callback: NodeCallback<void>): void {
  assertMode(mode)
  doAccess(path, 'chmod').then(() => callback(null), (error) => callback(error as Error))
}

export const lchmod = chmod

/**
 * `exists` is the caller's existence check: fs.existsSync, which works on a page too. It answers
 * false for a path outside the app's files, so the confinement check comes first and reports the
 * denial the asynchronous forms do.
 */
export function chmodSyncWith (exists: (path: PathLike) => boolean, path: PathLike, mode: unknown): void {
  assertMode(mode)
  confineSync(path, 'chmod', 'fs.chmodSync')
  if (!exists(path)) throw fsError('ENOENT', 'no such file or directory', 'chmod', typeof path === 'string' ? path : String(path))
}
