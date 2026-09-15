// fs.open's Node shape, over orivon.fs.open's FileHandle (handles.ts).
// THE LOCAL CURSOR IS THIS FILE'S WHOLE REASON TO EXIST: the contract
// deliberately has no implicit file position (handles.ts's own FileHandle
// doc comment -- a cursor is mutable state across an async IPC boundary,
// unsafe with a torrent writer's many in-flight positional writes), so
// Node's familiar `position: null` meaning "wherever this fd last left off"
// is reconstructed HERE, one layer up, never at the broker.
//
// THE CURSOR'S OWN CONTRACT MATCHES REAL NODE'S, NOT A SIMPLER ONE: a
// position of null/undefined/-1 is snapshotted BEFORE the call and advanced
// by the ACTUAL bytes transferred only once it resolves (Node's own
// lib/internal/fs/promises.js does exactly this for `kFilePosition`). Two
// null-position calls issued without awaiting the first race onto the same
// snapshot -- real Node's own documented hazard for concurrent fs.read/
// fs.write on one fd, not a bug introduced here.
//
// SCOPE LIMIT: FileHandle.readable()/writable() are built in the broker but
// not page-reachable yet (A184, docs/open-questions.md) -- createReadStream/
// createWriteStream below refuse loudly by name rather than faking a stream
// this shim cannot actually get bytes through yet.

import type { FileHandle } from '../contracts/handles.js'
import { getOrivon } from './orivon-global.js'
import { toNodeError } from './node-http-errors.js'
import { toNodeStats, type NodeStats } from './node-fs-stats.js'
import { refuseShim } from './errors.js'

export type NodeCallback<T> = (error: Error | null, result?: T) => void

export interface NodeFsReadResult { bytesRead: number, buffer: Uint8Array }
export interface NodeFsWriteResult { bytesWritten: number, buffer: Uint8Array }

/** Node's own append-mode flag spellings -- the only ones that start the local cursor anywhere but 0. */
const APPEND_FLAGS = new Set(['a', 'ax', 'a+', 'ax+', 'as', 'as+'])

async function guarded<T> (run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw toNodeError(error)
  }
}

class LocalCursor {
  private position: number
  constructor (start: number) { this.position = start }

  async run (requested: number | null | undefined, op: (position: number) => Promise<number>): Promise<number> {
    const usesCursor = requested === null || requested === undefined || requested === -1
    const position = usesCursor ? this.position : requested
    const bytes = await op(position)
    if (usesCursor) this.position += bytes
    return bytes
  }
}

async function initialCursor (handle: FileHandle, flags: string): Promise<number> {
  if (!APPEND_FLAGS.has(flags)) return 0
  return (await handle.stat()).size
}

/** fd -> handle, shared by fs.promises.open and the callback open/read/write/close family below (one registry, matching real Node's own fd being usable through either surface -- not two competing tables). */
const openByFd = new Map<number, NodeFileHandle>()
let nextFd = 4

function badFd (fd: number): Error & { code: string } {
  return Object.assign(new Error(`orivon-node-shim: EBADF, bad file descriptor (fd ${fd})`), { code: 'EBADF' })
}

export class NodeFileHandle {
  readonly fd: number
  private readonly handle: FileHandle
  private readonly cursor: LocalCursor

  private constructor (fd: number, handle: FileHandle, cursor: LocalCursor) {
    this.fd = fd
    this.handle = handle
    this.cursor = cursor
  }

  static async open (path: string, flags: string): Promise<NodeFileHandle> {
    return await guarded(async () => {
      const handle = await getOrivon().fs.open(path, flags)
      const cursor = new LocalCursor(await initialCursor(handle, flags))
      const fd = nextFd++
      const wrapped = new NodeFileHandle(fd, handle, cursor)
      openByFd.set(fd, wrapped)
      return wrapped
    })
  }

  async read (buffer: Uint8Array, offset = 0, length: number = buffer.length - offset, position: number | null = null): Promise<NodeFsReadResult> {
    const bytesRead = await guarded(async () => await this.cursor.run(position, async (at) => {
      const bytes = await this.handle.read({ position: at, length })
      buffer.set(bytes, offset)
      return bytes.length
    }))
    return { bytesRead, buffer }
  }

  async write (buffer: Uint8Array, offset = 0, length: number = buffer.length - offset, position: number | null = null): Promise<NodeFsWriteResult> {
    const data = offset === 0 && length === buffer.length ? buffer : buffer.subarray(offset, offset + length)
    const bytesWritten = await guarded(async () => await this.cursor.run(position, async (at) => await this.handle.write({ position: at, data })))
    return { bytesWritten, buffer }
  }

  async stat (): Promise<NodeStats> { return await guarded(async () => toNodeStats(await this.handle.stat())) }
  async truncate (length = 0): Promise<void> { await guarded(async () => { await this.handle.truncate(length) }) }
  async sync (): Promise<void> { await guarded(async () => { await this.handle.sync() }) }

  async close (): Promise<void> {
    openByFd.delete(this.fd)
    await guarded(async () => { await this.handle.close() })
  }

  /** Real Node's own FileHandle stream methods -- A184: the broker has readable()/writable() built, but neither reaches a page yet, so this refuses by name instead of returning a stream that can never move a byte. */
  createReadStream (_opts?: { start?: number, end?: number }): never {
    throw refuseShim(
      'FileHandle#createReadStream', 'not-built',
      'FileHandle.readable() is built in the broker but not page-reachable yet -- see ' +
      'docs/open-questions.md A184. Use read() positionally, or fs.readFile() for whole-file access.'
    )
  }

  createWriteStream (_opts?: { start?: number }): never {
    throw refuseShim(
      'FileHandle#createWriteStream', 'not-built',
      'FileHandle.writable() is built in the broker but not page-reachable yet -- see ' +
      'docs/open-questions.md A184. Use write() positionally, or fs.writeFile() for whole-file access.'
    )
  }
}

// ---- fs.promises.open --------------------------------------------------

export async function openHandle (path: string, flags: string, _mode?: number): Promise<NodeFileHandle> {
  return await NodeFileHandle.open(path, flags)
}

// ---- callback fs.open/fs.read/fs.write/fs.close/fs.fstat/... ----------

/** `fs.open(path, flags[, mode], callback)`. `mode` is a POSIX permission bit this confined fs has nothing to set it on (node-fs.ts's own `not-applicable` reasoning for chmod/chown) -- accepted and ignored, never silently misread as the callback. */
export function open (path: string, flags: string, callback: NodeCallback<number>): void
export function open (path: string, flags: string, mode: number, callback: NodeCallback<number>): void
export function open (path: string, flags: string, ...args: readonly unknown[]): void {
  if (typeof flags === 'function') {
    throw new TypeError(
      'orivon-node-shim: fs.open(path, callback), defaulting flags to \'r\', is not supported -- ' +
      "pass flags explicitly, e.g. fs.open(path, 'r', callback)."
    )
  }
  const callback = (args.length > 1 ? args[1] : args[0]) as NodeCallback<number>
  NodeFileHandle.open(path, flags).then(
    (handle) => callback(null, handle.fd),
    (error) => callback(error as Error)
  )
}

export function close (fd: number, callback: NodeCallback<void>): void {
  const handle = openByFd.get(fd)
  if (handle === undefined) { callback(badFd(fd)); return }
  handle.close().then(() => callback(null), (error) => callback(error as Error))
}

export function read (
  fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null,
  callback: (error: Error | null, bytesRead: number, buffer: Uint8Array) => void
): void {
  const handle = openByFd.get(fd)
  if (handle === undefined) { callback(badFd(fd), 0, buffer); return }
  handle.read(buffer, offset, length, position).then(
    (result) => callback(null, result.bytesRead, result.buffer),
    (error) => callback(error as Error, 0, buffer)
  )
}

type WriteCallback = (error: Error | null, bytesWritten: number, buffer: Uint8Array) => void

/** `fs.write(fd, buffer[, offset[, length[, position]]], callback)` -- every trailing arg after `buffer` is optional, matching real Node's own defaults (offset 0, the rest of the buffer, the fd's current cursor). */
export function write (fd: number, buffer: Uint8Array, callback: WriteCallback): void
export function write (fd: number, buffer: Uint8Array, offset: number, callback: WriteCallback): void
export function write (fd: number, buffer: Uint8Array, offset: number, length: number, callback: WriteCallback): void
export function write (fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, callback: WriteCallback): void
export function write (fd: number, buffer: Uint8Array, ...args: readonly unknown[]): void {
  const callback = args[args.length - 1] as WriteCallback
  const rest = args.slice(0, -1)
  const offset = typeof rest[0] === 'number' ? rest[0] : 0
  const length = typeof rest[1] === 'number' ? rest[1] : buffer.length - offset
  const position = rest.length > 2 ? rest[2] as number | null : null
  const handle = openByFd.get(fd)
  if (handle === undefined) { callback(badFd(fd), 0, buffer); return }
  handle.write(buffer, offset, length, position).then(
    (result) => callback(null, result.bytesWritten, result.buffer),
    (error) => callback(error as Error, 0, buffer)
  )
}

export function fstat (fd: number, callback: NodeCallback<NodeStats>): void {
  const handle = openByFd.get(fd)
  if (handle === undefined) { callback(badFd(fd)); return }
  handle.stat().then((stat) => callback(null, stat), (error) => callback(error as Error))
}

export function ftruncate (fd: number, callback: NodeCallback<void>): void
export function ftruncate (fd: number, length: number, callback: NodeCallback<void>): void
export function ftruncate (fd: number, ...args: readonly unknown[]): void {
  const callback = args[args.length - 1] as NodeCallback<void>
  const length = args.length > 1 ? args[0] as number : 0
  const handle = openByFd.get(fd)
  if (handle === undefined) { callback(badFd(fd)); return }
  handle.truncate(length).then(() => callback(null), (error) => callback(error as Error))
}

export function fsync (fd: number, callback: NodeCallback<void>): void {
  const handle = openByFd.get(fd)
  if (handle === undefined) { callback(badFd(fd)); return }
  handle.sync().then(() => callback(null), (error) => callback(error as Error))
}
