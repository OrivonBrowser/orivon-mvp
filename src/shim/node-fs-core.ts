// The async core node-fs.ts's callback family and node-fs-promises.ts's
// `fs.promises` both call -- one implementation per operation, never two
// (code-guidelines.md Rule 3), so encoding, error-mapping and the
// append-vs-write choice cannot drift between the two surfaces the way they
// would if each re-implemented its own copy over `getOrivon().fs.*`.
//
// EVERY EXPORTED do*() FUNCTION HERE THROWS AN ALREADY NODE-SHAPED ERROR,
// EXACTLY ONCE -- never a raw OrivonError. A caller (callback wrapper or
// promise export) must never wrap the rejection through toNodeError a
// second time: doAppendFile's error already passed through it once, inside
// node-fs-handle.ts's own `guarded()`, and re-mapping an error whose `.code`
// is already a platform errno (not one of OrivonErrorCode's closed values)
// would silently overwrite it with toNodeError's 'internal' fallback.
//
// PATHS ARE NEVER RESOLVED, JOINED OR NORMALISED HERE. `path` reaches
// `getOrivon().fs.*` exactly as the caller wrote it -- a relative path like
// `settings.db` lands wherever the BROKER resolves it, which is the app's
// own files directory root (capability-api.ts's OrivonFs doc: "Rooted at the
// app's files directory... resolved and confined IN THE BROKER, never
// trusted from the renderer"). Calling path.resolve/path.normalize on `path`
// before handing it over would be wrong, not merely redundant: it could
// change which root a relative path resolves against, or defeat the
// broker's own confinement check by pre-resolving a traversal this layer has
// no authority to approve.

import { getOrivon } from './orivon-global.js'
import { toNodeError } from './node-http-errors.js'
import { toBytes } from './node-stream-bytes.js'
import { toNodeStats, type NodeStats } from './node-fs-stats.js'
import { openHandle } from './node-fs-handle.js'
import { Buffer } from 'buffer'

export interface ReadFileOptions { encoding?: string }
export interface WriteFileOptions { encoding?: string }
export interface MkdirOptions { recursive?: boolean }
export interface RmOptions { recursive?: boolean }

// hex/base64/base64url are Node's binary-to-text encodings, not character
// sets -- TextDecoder only knows the latter (WHATWG Encoding Standard) and
// throws RangeError on these three. Buffer (the `buffer` package) already
// implements Node's own encoding table, so those three are routed there and
// everything else keeps going through TextDecoder.
const BUFFER_TEXT_ENCODINGS = new Set(['hex', 'base64', 'base64url'])

export function decode (bytes: Uint8Array, encoding: string | undefined): Uint8Array | string {
  if (encoding === undefined) return Buffer.from(bytes)
  if (BUFFER_TEXT_ENCODINGS.has(encoding)) return Buffer.from(bytes).toString(encoding as 'hex' | 'base64' | 'base64url')
  return new TextDecoder(encoding).decode(bytes)
}

/** writeFile's mirror of decode() above -- Buffer.from already knows every Node encoding, hex/base64/base64url included, so unlike decode() this needs no special-cased subset. */
export function encode (data: unknown, encoding: string | undefined): Uint8Array {
  return typeof data === 'string' ? Buffer.from(data, (encoding ?? 'utf8') as BufferEncoding) : toBytes(data)
}

export async function doReadFile (path: string, encoding: string | undefined): Promise<Uint8Array | string> {
  try {
    return decode(await getOrivon().fs.readFile(path), encoding)
  } catch (error) {
    throw toNodeError(error)
  }
}

export async function doWriteFile (path: string, data: unknown, encoding: string | undefined): Promise<void> {
  // encode() can throw synchronously (an unsupported encoding name, a chunk
  // that is neither a string nor bytes) -- inside this async function body
  // that becomes a normal rejection, exactly like every I/O failure below,
  // rather than needing its own try/catch at every call site.
  const bytes = encode(data, encoding)
  try {
    await getOrivon().fs.writeFile(path, bytes)
  } catch (error) {
    throw toNodeError(error)
  }
}

/**
 * A REAL append, through fs.open(path, 'a') plus one positional write --
 * never read-modify-write. node-fs-handle.ts's `initialCursor` already seeds
 * the local cursor at the file's current size for every append-mode flag
 * (APPEND_FLAGS), and 'a' is one of `VALID_OPEN_FLAGS`
 * (fs-handle-wrapper.ts) the broker already accepts -- so a single
 * cursor-relative write (position omitted) lands exactly at EOF with no
 * extra read, no extra round trip, and no quota charge for bytes this call
 * never touches. On a write failure the handle is still closed (best
 * effort, swallowing a close error so it cannot hide the real one) before
 * the original error propagates.
 */
export async function doAppendFile (path: string, data: unknown, encoding: string | undefined): Promise<void> {
  const bytes = encode(data, encoding)
  const handle = await openHandle(path, 'a')
  try {
    await handle.write(bytes, 0, bytes.length)
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
  await handle.close()
}

export async function doMkdir (path: string, opts: MkdirOptions | undefined): Promise<void> {
  try {
    await getOrivon().fs.mkdir(path, opts)
  } catch (error) {
    throw toNodeError(error)
  }
}

export async function doReaddir (path: string): Promise<readonly string[]> {
  try {
    return await getOrivon().fs.readdir(path)
  } catch (error) {
    throw toNodeError(error)
  }
}

export async function doStat (path: string): Promise<NodeStats> {
  try {
    return toNodeStats(await getOrivon().fs.stat(path))
  } catch (error) {
    throw toNodeError(error)
  }
}

export async function doRm (path: string, opts: RmOptions | undefined): Promise<void> {
  try {
    await getOrivon().fs.rm(path, opts)
  } catch (error) {
    throw toNodeError(error)
  }
}

export async function doRename (from: string, to: string): Promise<void> {
  try {
    await getOrivon().fs.rename(from, to)
  } catch (error) {
    throw toNodeError(error)
  }
}

/** Real Node's fs.unlink never takes a `recursive` option -- orivon.fs has no separate unlink primitive, so this rides fs.rm with none given, failing on a directory the same non-recursive way rm's own callers already do. */
export async function doUnlink (path: string): Promise<void> {
  try {
    await getOrivon().fs.rm(path)
  } catch (error) {
    throw toNodeError(error)
  }
}

/**
 * `mode` (F_OK/R_OK/W_OK/X_OK) is accepted but not distinguished: orivon.fs
 * has no POSIX permission bits to check any of R_OK/W_OK/X_OK against
 * (node-fs-unsupported.ts's chmod/chown reasoning), so existence -- via
 * stat(), the same signal a grant-denied or confinement-denied path already
 * fails on -- is the only thing this can honestly answer for any mode.
 * Not owner-reviewed: README.md §Design notes, "fs.access's mode".
 */
export async function doAccess (path: string): Promise<void> {
  try {
    await getOrivon().fs.stat(path)
  } catch (error) {
    throw toNodeError(error)
  }
}
