// fs.createReadStream / fs.createWriteStream -- built over node-fs-handle.ts's
// OWN local-cursor FileHandle (open once, then repeated positional
// read/write), never over the broker's FileHandle.readable()/writable()
// factories that A184 (docs/open-questions.md) stops at the broker layer,
// not yet reachable from a page. This sidesteps that gap entirely: these
// classes drive the exact same open/read/write/close primitives fs.open's
// callback family already uses, just in a loop, from inside a real
// stream.Readable/Writable -- the same 'stream' polyfill node-http-message.ts's
// IncomingMessage and node-net-socket.ts's Socket already extend.
//
// FileHandle#createReadStream/createWriteStream -- the INSTANCE methods on a
// handle from fs.open()/fs.promises.open() -- still refuse, citing A184.
// This file does not change that and does not call them: it owns the whole
// file lifecycle itself (opens, drives every read/write, closes), so the
// broker's stream factories never enter the picture.
//
// REACHED BY A REAL CALLER, NOT SPECULATIVE: @seald-io/nedb's Node storage
// layer (lib/storage.js) captures both unconditionally at module load
// (`fs.createWriteStream`/`fs.createReadStream`) and its persistence layer
// (lib/persistence.js) calls them on every database load and every
// compaction -- see src/shim/tests/nedb-storage.test.ts.
//
// SIDESTEPPING A184 IS A SCOPE CALL, NOT A DISCOVERED FIX -- flagged, not
// owner-reviewed: README.md §Design notes, "createReadStream/createWriteStream".

import { Readable, Writable } from 'stream'
import { Buffer } from 'buffer'
import { isAppendFlag, NodeFileHandle } from './node-fs-handle.js'
import { toBytes } from './node-stream-bytes.js'
import type { PathLike } from './node-fs-path.js'

const DEFAULT_CHUNK_SIZE = 64 * 1024

// Node's fs streams destroy themselves at end/finish and on error, which
// releases the handle and emits 'close'. readable-stream 3, the page's
// `stream`, defaults autoDestroy to false, and turning it on for a Writable
// swallows a failed write's 'error' event (it marks the error emitted before
// destroying), so both classes here destroy by hand instead. Never from an
// 'error' listener: one would stop an unhandled stream error being thrown.

export interface ReadStreamOptions {
  start?: number
  end?: number
  encoding?: string
}

export interface WriteStreamOptions {
  start?: number
  flags?: string
}

export class ReadStream extends Readable {
  private readonly opening: Promise<NodeFileHandle>
  private position: number
  /** Bytes still wanted, INCLUSIVE of opts.end (Node's own convention) -- Infinity when no `end` was given, meaning "until EOF". */
  private remaining: number
  private pulling = false

  constructor (path: PathLike, opts: ReadStreamOptions = {}) {
    super()
    this.once('end', () => this.destroy())
    if (opts.encoding !== undefined) this.setEncoding(opts.encoding as BufferEncoding)
    const start = opts.start ?? 0
    this.position = start
    this.remaining = opts.end === undefined ? Infinity : opts.end - start + 1
    this.opening = NodeFileHandle.open(path, 'r')
    // Real Node emits 'open'/'ready' with the fd once it exists, before any
    // data -- a caller inspecting them from those events sees a real value.
    // The rejection branch destroys the stream rather than letting the open
    // failure surface only when `_read` is first called.
    this.opening.then(
      (handle) => { this.emit('open', handle.fd); this.emit('ready') },
      (error) => this.destroy(error as Error)
    ).catch(() => {})
  }

  override _read (size: number): void {
    if (this.pulling) return
    this.pulling = true
    this.pull(size).catch((error) => { this.pulling = false; this.destroy(error as Error) })
  }

  private async pull (_size: number): Promise<void> {
    if (this.remaining <= 0) { this.pulling = false; this.push(null); return }
    let handle: NodeFileHandle
    try {
      handle = await this.opening
    } catch {
      // Already destroyed by the constructor's own rejection handler.
      this.pulling = false
      return
    }
    const length = this.remaining === Infinity ? DEFAULT_CHUNK_SIZE : Math.min(DEFAULT_CHUNK_SIZE, this.remaining)
    const { buffer, bytesRead } = await handle.read(new Uint8Array(length), 0, length, this.position)
    this.pulling = false
    if (bytesRead === 0) { this.push(null); return }
    this.position += bytesRead
    if (this.remaining !== Infinity) this.remaining -= bytesRead
    this.push(Buffer.from(buffer.subarray(0, bytesRead)))
  }

  override _destroy (error: Error | null, callback: (error?: Error | null) => void): void {
    this.opening.then(async (handle) => { await handle.close() }, () => {}).finally(() => callback(error))
  }
}

export class WriteStream extends Writable {
  private readonly opening: Promise<NodeFileHandle>
  /** null writes at the handle's own cursor, which an append flag starts at EOF. */
  private position: number | null
  private didClose = false

  constructor (path: PathLike, opts: WriteStreamOptions = {}) {
    super()
    this.once('finish', () => this.destroy())
    this.once('close', () => { this.didClose = true })
    const flags = opts.flags ?? 'w'
    // An append flag writes at EOF, whatever `start` says, as in Node.
    this.position = isAppendFlag(flags) ? null : opts.start ?? 0
    this.opening = NodeFileHandle.open(path, flags)
    this.opening.then(
      (handle) => { this.emit('open', handle.fd); this.emit('ready') },
      (error) => this.destroy(error as Error)
    ).catch(() => {})
  }

  override _write (chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    let bytes: Uint8Array
    try {
      bytes = toBytes(chunk)
    } catch (error) {
      this.fail(error, callback)
      return
    }
    this.writeChunk(bytes).then(() => callback(), (error) => this.fail(error, callback))
  }

  /** The callback emits 'error'; destroying after it releases the handle, as Node's autoDestroy would. */
  private fail (error: unknown, callback: (error?: Error | null) => void): void {
    callback(error as Error)
    this.destroy()
  }

  private async writeChunk (bytes: Uint8Array): Promise<void> {
    const handle = await this.opening
    const { bytesWritten } = await handle.write(bytes, 0, bytes.length, this.position)
    if (this.position !== null) this.position += bytesWritten
  }

  override _destroy (error: Error | null, callback: (error?: Error | null) => void): void {
    this.opening.then(async (handle) => { await handle.close() }, () => {}).finally(() => callback(error))
  }

  /**
   * Real Node's fs.WriteStream#close: end the stream and call back on
   * 'close', emitted once `_destroy` has released the handle.
   */
  close (callback?: (error?: Error | null) => void): void {
    if (callback !== undefined) {
      if (this.didClose) queueMicrotask(() => callback())
      else this.once('close', () => callback())
    }
    this.end()
  }
}

export function createReadStream (path: PathLike, opts?: ReadStreamOptions): ReadStream {
  return new ReadStream(path, opts)
}

export function createWriteStream (path: PathLike, opts?: WriteStreamOptions): WriteStream {
  return new WriteStream(path, opts)
}
