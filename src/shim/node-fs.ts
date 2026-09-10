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
// TWO GAPS, NAMED RATHER THAN FAKED: fs.open (no FileHandle capability yet)
// and every synchronous export except readFileSync (ADR-0016 grants exactly
// one) -- both throw a named, explanatory error via node-fs-unsupported.ts,
// the same treatment node-http-unsupported.ts and node-net-unsupported.ts
// give their own gaps.

import { getOrivon } from './orivon-global.js'
import { toNodeError } from './node-http-errors.js'
import { toBytes } from './node-stream-bytes.js'
import { toNodeStats, type NodeStats } from './node-fs-stats.js'
import { open, syncUnsupported } from './node-fs-unsupported.js'
import { Buffer } from 'buffer'

export { open } from './node-fs-unsupported.js'

interface ReadFileOptions { encoding?: string }
interface WriteFileOptions { encoding?: string }
interface MkdirOptions { recursive?: boolean }
interface RmOptions { recursive?: boolean }

type NodeCallback<T> = (error: Error | null, result?: T) => void

/** Pops a trailing callback and an optional options object from a variadic tail -- the shape every fs.* call below shares once its own required leading args are removed. */
function splitTail<Options> (args: readonly unknown[]): { options: Options | undefined, callback: NodeCallback<unknown> } {
  const rest = [...args]
  const callback = rest.pop() as NodeCallback<unknown>
  const options = rest.length > 0 ? rest[0] as Options : undefined
  return { options, callback }
}

function decode (bytes: Uint8Array, encoding: string | undefined): Uint8Array | string {
  return encoding === undefined ? Buffer.from(bytes) : new TextDecoder(encoding).decode(bytes)
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
  getOrivon().fs.readFile(path)
    .then((bytes) => callback(null, decode(bytes, encoding)))
    .catch((error) => callback(toNodeError(error)))
}

export function readFileSync (path: string, options?: ReadFileOptions | string): Uint8Array | string {
  const encoding = typeof options === 'string' ? options : options?.encoding
  const bytes = getOrivon().fs.readFileSync(path)
  return decode(bytes, encoding)
}

export function writeFile (path: string, data: unknown, callback: NodeCallback<void>): void
export function writeFile (path: string, data: unknown, options: WriteFileOptions | string, callback: NodeCallback<void>): void
export function writeFile (path: string, data: unknown, ...args: readonly unknown[]): void {
  const { callback } = splitTail<WriteFileOptions | string>(args)
  let bytes: Uint8Array
  try {
    bytes = toBytes(data)
  } catch (error) {
    callback(error as Error)
    return
  }
  getOrivon().fs.writeFile(path, bytes)
    .then(() => callback(null))
    .catch((error) => callback(toNodeError(error)))
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
  getOrivon().fs.mkdir(path, options)
    .then(() => callback(null))
    .catch((error) => callback(toNodeError(error)))
}

export function readdir (path: string, callback: NodeCallback<readonly string[]>): void
export function readdir (path: string, ...args: readonly unknown[]): void {
  const { callback } = splitTail<unknown>(args)
  getOrivon().fs.readdir(path)
    .then((entries) => callback(null, entries))
    .catch((error) => callback(toNodeError(error)))
}

export function stat (path: string, callback: NodeCallback<NodeStats>): void
export function stat (path: string, ...args: readonly unknown[]): void {
  const { callback } = splitTail<unknown>(args)
  getOrivon().fs.stat(path)
    .then((result) => callback(null, toNodeStats(result)))
    .catch((error) => callback(toNodeError(error)))
}

export function rm (path: string, callback: NodeCallback<void>): void
export function rm (path: string, options: RmOptions, callback: NodeCallback<void>): void
export function rm (path: string, ...args: readonly unknown[]): void {
  const { options, callback } = splitTail<RmOptions>(args)
  getOrivon().fs.rm(path, options)
    .then(() => callback(null))
    .catch((error) => callback(toNodeError(error)))
}

export function rename (from: string, to: string, callback: NodeCallback<void>): void {
  getOrivon().fs.rename(from, to)
    .then(() => callback(null))
    .catch((error) => callback(toNodeError(error)))
}

export type { NodeStats }

export default {
  readFile, readFileSync, writeFile, writeFileSync,
  mkdir, readdir, stat, rm, rename, open,
  statSync, mkdirSync, readdirSync, rmSync, renameSync, existsSync
}
