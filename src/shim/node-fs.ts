// `fs` module target (module-map.ts). Wraps orivon.fs's promise-returning
// methods (capability-api.ts) in Node's callback shape, since every
// confirmed caller in the target graph (fs-chunk-store, webtorrent's own
// torrent.js) uses plain callback-style fs, never fs.promises.
//
// ENCODING IS THIS FILE'S JOB, NOT ORIVON'S. orivon.fs is deliberately
// byte-oriented (handles.ts's OrivonFs doc comment, A12) -- readFile/
// writeFile here decode/encode against `options.encoding` themselves, the
// same layer split node-http-message.ts already draws between wire bytes
// and the Node shape presented on top.
//
// fs.open (node-fs-handle.ts) is real now: a local cursor over
// orivon.fs.open's FileHandle, exposed as fs.promises.open and the callback
// open/read/write/close family -- see that file's own header for why the
// cursor lives there. Every synchronous export except readFileSync
// (ADR-0016) is still a named refusal (node-fs-unsupported.ts).
//
// EVERY OTHER fs MEMBER (A135) names its gap rather than reading
// `undefined` off the default export: `chmod`/`chown` are 'not-applicable'
// (no POSIX uid/gid/mode model), `createReadStream`/`createWriteStream` are
// A184 (node-fs-handle.ts's FileHandle refuses the same broker-stream gap),
// everything else is 'unimplemented'.

import { getOrivon } from './orivon-global.js'
import { toNodeError } from './node-http-errors.js'
import { toBytes } from './node-stream-bytes.js'
import { toNodeStats, type NodeStats } from './node-fs-stats.js'
import { syncUnsupported } from './node-fs-unsupported.js'
import { open, openHandle, close, read, write, fstat, ftruncate, fsync, type NodeCallback } from './node-fs-handle.js'
import { refusingProxy } from './unimplemented.js'
import { refuseShim } from './errors.js'
import { Buffer } from 'buffer'

export { open, close, read, write, fstat, ftruncate, fsync } from './node-fs-handle.js'
export const promises = refusingProxy({ open: openHandle }, (prop) => refuseShim(
  `fs.promises.${prop}`, 'unimplemented',
  `fs.promises.${prop} is real Node fs surface this shim has not implemented and has not ` +
  'decided whether it will -- distinct from fs.promises.open, which is built. See ' +
  'docs/planning/compatibility-matrix.md Table 3.'
))

interface ReadFileOptions { encoding?: string }
interface WriteFileOptions { encoding?: string }
interface MkdirOptions { recursive?: boolean }
interface RmOptions { recursive?: boolean }

/** Pops a trailing callback and an optional options object from a variadic tail -- the shape every fs.* call below shares once its own required leading args are removed. */
function splitTail<Options> (args: readonly unknown[]): { options: Options | undefined, callback: NodeCallback<unknown> } {
  const rest = [...args]
  const callback = rest.pop() as NodeCallback<unknown>
  const options = rest.length > 0 ? rest[0] as Options : undefined
  return { options, callback }
}

// hex/base64/base64url are Node's binary-to-text encodings, not character
// sets -- TextDecoder only knows the latter (WHATWG Encoding Standard) and
// throws RangeError on these three. Buffer (the `buffer` package) already
// implements Node's own encoding table, so those three are routed there and
// everything else keeps going through TextDecoder.
const BUFFER_TEXT_ENCODINGS = new Set(['hex', 'base64', 'base64url'])

function decode (bytes: Uint8Array, encoding: string | undefined): Uint8Array | string {
  if (encoding === undefined) return Buffer.from(bytes)
  if (BUFFER_TEXT_ENCODINGS.has(encoding)) return Buffer.from(bytes).toString(encoding as 'hex' | 'base64' | 'base64url')
  return new TextDecoder(encoding).decode(bytes)
}

/** writeFile's mirror of decode() above -- Buffer.from already knows every Node encoding, hex/base64/base64url included, so unlike decode() this needs no special-cased subset. */
function encode (data: unknown, encoding: string | undefined): Uint8Array {
  return typeof data === 'string' ? Buffer.from(data, (encoding ?? 'utf8') as BufferEncoding) : toBytes(data)
}

// Every function below is declared with real Node-shaped overloads (options
// optional, before the callback) rather than one loose `...args: unknown[]`
// signature, so a caller's callback parameters are inferred, not `any` --
// the implementation signature (the last one) still accepts the same
// variadic tail every overload above it can produce.

export function readFile (path: string, callback: NodeCallback<Uint8Array | string>): void
export function readFile (path: string, options: ReadFileOptions | string, callback: NodeCallback<Uint8Array | string>): void
export function readFile (path: string, ...args: readonly unknown[]): void {
  const { options, callback } = splitTail<ReadFileOptions | string>(args)
  const encoding = typeof options === 'string' ? options : options?.encoding
  // `.then(onFulfilled, onRejected)`, never `.then(onFulfilled).catch(onRejected)`:
  // the two-callback form is the only one where a throw INSIDE onFulfilled
  // (here, inside the user's own callback) does not fall into onRejected and
  // re-invoke callback a second time. Node calls a callback exactly once --
  // every wrapper below relies on this same shape for that guarantee.
  getOrivon().fs.readFile(path).then(
    (bytes) => callback(null, decode(bytes, encoding)),
    (error) => callback(toNodeError(error))
  )
}

export function readFileSync (path: string, options?: ReadFileOptions | string): Uint8Array | string {
  const encoding = typeof options === 'string' ? options : options?.encoding
  const bytes = getOrivon().fs.readFileSync(path)
  return decode(bytes, encoding)
}

export function writeFile (path: string, data: unknown, callback: NodeCallback<void>): void
export function writeFile (path: string, data: unknown, options: WriteFileOptions | string, callback: NodeCallback<void>): void
export function writeFile (path: string, data: unknown, ...args: readonly unknown[]): void {
  const { options, callback } = splitTail<WriteFileOptions | string>(args)
  const encoding = typeof options === 'string' ? options : options?.encoding
  let bytes: Uint8Array
  try {
    bytes = encode(data, encoding)
  } catch (error) {
    callback(error as Error)
    return
  }
  getOrivon().fs.writeFile(path, bytes).then(
    () => callback(null),
    (error) => callback(toNodeError(error))
  )
}

export const writeFileSync = syncUnsupported('fs.writeFileSync')
export const statSync = syncUnsupported('fs.statSync')
export const mkdirSync = syncUnsupported('fs.mkdirSync')
export const readdirSync = syncUnsupported('fs.readdirSync')
export const rmSync = syncUnsupported('fs.rmSync')
export const renameSync = syncUnsupported('fs.renameSync')
export const existsSync = syncUnsupported('fs.existsSync')

export function mkdir (path: string, callback: NodeCallback<void>): void
export function mkdir (path: string, options: MkdirOptions, callback: NodeCallback<void>): void
export function mkdir (path: string, ...args: readonly unknown[]): void {
  const { options, callback } = splitTail<MkdirOptions>(args)
  getOrivon().fs.mkdir(path, options).then(
    () => callback(null),
    (error) => callback(toNodeError(error))
  )
}

export function readdir (path: string, callback: NodeCallback<readonly string[]>): void
export function readdir (path: string, ...args: readonly unknown[]): void {
  const { callback } = splitTail<unknown>(args)
  getOrivon().fs.readdir(path).then(
    (entries) => callback(null, entries),
    (error) => callback(toNodeError(error))
  )
}

export function stat (path: string, callback: NodeCallback<NodeStats>): void
export function stat (path: string, ...args: readonly unknown[]): void {
  const { callback } = splitTail<unknown>(args)
  getOrivon().fs.stat(path).then(
    (result) => callback(null, toNodeStats(result)),
    (error) => callback(toNodeError(error))
  )
}

export function rm (path: string, callback: NodeCallback<void>): void
export function rm (path: string, options: RmOptions, callback: NodeCallback<void>): void
export function rm (path: string, ...args: readonly unknown[]): void {
  const { options, callback } = splitTail<RmOptions>(args)
  getOrivon().fs.rm(path, options).then(
    () => callback(null),
    (error) => callback(toNodeError(error))
  )
}

export function rename (from: string, to: string, callback: NodeCallback<void>): void {
  getOrivon().fs.rename(from, to).then(
    () => callback(null),
    (error) => callback(toNodeError(error))
  )
}

export type { NodeStats }

const POSIX_PERMISSION_MEMBERS = new Set(['chmod', 'chmodSync', 'chown', 'chownSync'])
const STREAM_GAP_MEMBERS = new Set(['createReadStream', 'createWriteStream'])

function otherFsMember (prop: string) {
  if (POSIX_PERMISSION_MEMBERS.has(prop)) {
    return refuseShim(
      `fs.${prop}`, 'not-applicable',
      `fs.${prop} sets a POSIX permission/ownership bit -- this shim's confined fs has no uid, ` +
      'gid or mode to set one on (compatibility-matrix.md Table 3).'
    )
  }
  if (STREAM_GAP_MEMBERS.has(prop)) {
    return refuseShim(
      `fs.${prop}`, 'not-built',
      `fs.${prop} needs FileHandle.readable()/writable(), which the broker builds but does not ` +
      'expose to a page yet -- see docs/open-questions.md A184. Use fs.readFile/writeFile for ' +
      'whole-file access, or fs.open plus positional read/write, instead.'
    )
  }
  return refuseShim(
    `fs.${prop}`, 'unimplemented',
    `fs.${prop} is real Node fs surface this shim has not implemented and has not decided ` +
    'whether it will -- distinct from the *Sync gaps above, which are a decided, permanent ' +
    'refusal (ADR-0016). See docs/planning/compatibility-matrix.md Table 3.'
  )
}

export default refusingProxy({
  readFile, readFileSync, writeFile, writeFileSync,
  mkdir, readdir, stat, rm, rename, open, close, read, write, fstat, ftruncate, fsync, promises,
  statSync, mkdirSync, readdirSync, rmSync, renameSync, existsSync
}, otherFsMember)
