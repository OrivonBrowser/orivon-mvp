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
import { NodeFileHandle } from './node-fs-handle.js'
import { toBytes } from './node-stream-bytes.js'

const DEFAULT_CHUNK_SIZE = 64 * 1024

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

  constructor (path: string, opts: ReadStreamOptions = {}) {
    super()
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
  private position: number
  private didClose = false

  constructor (path: string, opts: WriteStreamOptions = {}) {
    super()
    this.position = opts.start ?? 0
    this.opening = NodeFileHandle.open(path, opts.flags ?? 'w')
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
      callback(error as Error)
      return
    }
    this.writeChunk(bytes).then(() => callback(), (error) => callback(error as Error))
  }

  private async writeChunk (bytes: Uint8Array): Promise<void> {
    const handle = await this.opening
    const { bytesWritten } = await handle.write(bytes, 0, bytes.length, this.position)
    this.position += bytesWritten
  }

  override _destroy (error: Error | null, callback: (error?: Error | null) => void): void {
    this.opening.then(async (handle) => { await handle.close() }, () => {}).finally(() => callback(error))
  }

  /**
   * Real Node's fs.WriteStream#close -- not part of the base Writable,
   * since a generic stream has no fd to release.
   *
   * DRIVEN BY end()+destroy()'S OWN CALLBACKS, NEVER THE 'close' EVENT.
   * Node's real Writable emits 'close' automatically once 'finish' fires
   * (emitClose/autoDestroy, both default true there), which the previous
   * version of this method relied on -- correct against real Node, but not
   * guaranteed by the Writable contract itself, and the specific polyfill
   * this repository's own build actually bundles (`stream-browserify`,
   * aliased in webpack.orivon-datastore.config.cjs) does not emit it:
   * confirmed by running exactly this method against it, not assumed
   * (src/shim/tests/node-fs-streams.test.ts's own stream-browserify case).
   * `end()`'s callback (fires on 'finish') and `destroy()`'s own second
   * argument (fires once `_destroy` -- which actually closes the fd --
   * completes) are both part of Writable's documented public API on every
   * implementation, not an emergent behaviour one polyfill happens to
   * match, so chaining them here works the same under either.
   */
  close (callback?: (error?: Error | null) => void): void {
    if (this.didClose) {
      if (callback !== undefined) queueMicrotask(() => callback())
      return
    }
    this.end(() => {
      // @types/node's own `destroy(error?: Error): this` omits the second,
      // callback argument its REAL runtime signature accepts (and this
      // method depends on) -- a documented Node stream API
      // (`writable.destroy([error], [callback])`), just missing from this
      // declaration file. Cast `this`, not the extracted method: destroy()
      // reads `this._writableState` internally, so the call must still go
      // through real method-call syntax (`x.destroy(...)`), never a
      // standalone function reference, which loses that binding.
      interface DestroyWithCallback { destroy: (error: undefined, callback: (error?: Error | null) => void) => void }
      ;(this as unknown as DestroyWithCallback).destroy(undefined, (error) => {
        this.didClose = true
        callback?.(error ?? null)
      })
    })
  }
}

export function createReadStream (path: string, opts?: ReadStreamOptions): ReadStream {
  return new ReadStream(path, opts)
}

export function createWriteStream (path: string, opts?: WriteStreamOptions): WriteStream {
  return new WriteStream(path, opts)
}
