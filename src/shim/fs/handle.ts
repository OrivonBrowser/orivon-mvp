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

import type { FileHandle } from '../../contracts/handles.js'
import { getOrivon } from '../orivon-global.js'
import { toNodeStats, type NodeStats } from './stats.js'
import { confine, fsError, guarded, type PathLike } from './paths.js'
import { refuseShim } from '../errors.js'
import { assertRootOpenAllowed, isRootPath, rootDirectoryHandle, rootReadError, rootTruncateError, rootWriteError } from './root.js'

export type NodeCallback<T> = (error: Error | null, result?: T) => void

export interface NodeFsReadResult { bytesRead: number, buffer: Uint8Array }
export interface NodeFsWriteResult { bytesWritten: number, buffer: Uint8Array }

/** Node's own append-mode flag spellings -- the only ones that start the local cursor anywhere but 0. */
const APPEND_FLAGS = new Set(['a', 'ax', 'a+', 'ax+', 'as', 'as+'])

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

export function isAppendFlag (flags: string): boolean { return APPEND_FLAGS.has(flags) }

async function initialCursor (handle: FileHandle, flags: string): Promise<number> {
  if (!isAppendFlag(flags)) return 0
  return (await handle.stat()).size
}

/** fd -> handle, shared by fs.promises.open and the callback open/read/write/close family below (one registry, matching real Node's own fd being usable through either surface -- not two competing tables). */
const openByFd = new Map<number, NodeFileHandle>()
let nextFd = 4

function badFd (syscall: string): Error & { code: string } {
  return fsError('EBADF', 'bad file descriptor', syscall)
}

export class NodeFileHandle {
  readonly fd: number
  private readonly handle: FileHandle
  private readonly cursor: LocalCursor
  /** True only for the root-directory handle fs/root.ts builds -- read/write/truncate short-circuit before ever reaching `this.handle`'s own (unreachable in practice) versions of them, so their fabricated Node errno codes reach the caller unmangled by guarded()'s toNodeError, which only knows how to translate a real OrivonError. */
  private readonly isRoot: boolean

  private constructor (fd: number, handle: FileHandle, cursor: LocalCursor, isRoot = false) {
    this.fd = fd
    this.handle = handle
    this.cursor = cursor
    this.isRoot = isRoot
  }

  // `path` is mapped by fs/paths.ts's `confine`, the same as every other
  // fs call; the root ITSELF never reaches orivon.fs (fs/root.ts).
  static async open (path: PathLike, flags: string): Promise<NodeFileHandle> {
    const confined = await confine(path, 'open')
    if (isRootPath(confined)) {
      assertRootOpenAllowed(flags)
      const fd = nextFd++
      const wrapped = new NodeFileHandle(fd, rootDirectoryHandle(), new LocalCursor(0), true)
      openByFd.set(fd, wrapped)
      return wrapped
    }
    return await guarded(async () => {
      const handle = await getOrivon().fs.open(confined, flags)
      const cursor = new LocalCursor(await initialCursor(handle, flags))
      const fd = nextFd++
      const wrapped = new NodeFileHandle(fd, handle, cursor)
      openByFd.set(fd, wrapped)
      return wrapped
    })
  }

  async read (buffer: Uint8Array, offset = 0, length: number = buffer.length - offset, position: number | null = null): Promise<NodeFsReadResult> {
    if (this.isRoot) rootReadError()
    const bytesRead = await guarded(async () => await this.cursor.run(position, async (at) => {
      const bytes = await this.handle.read({ position: at, length })
      buffer.set(bytes, offset)
      return bytes.length
    }))
    return { bytesRead, buffer }
  }

  async write (buffer: Uint8Array, offset = 0, length: number = buffer.length - offset, position: number | null = null): Promise<NodeFsWriteResult> {
    if (this.isRoot) rootWriteError()
    const data = offset === 0 && length === buffer.length ? buffer : buffer.subarray(offset, offset + length)
    const bytesWritten = await guarded(async () => await this.cursor.run(position, async (at) => await this.handle.write({ position: at, data })))
    return { bytesWritten, buffer }
  }

  async stat (): Promise<NodeStats> { return await guarded(async () => toNodeStats(await this.handle.stat())) }

  async truncate (length = 0): Promise<void> {
    if (this.isRoot) rootTruncateError()
    await guarded(async () => { await this.handle.truncate(length) })
  }

  // No file-vs-directory branch, on purpose: whatever `getOrivon().fs.open`
  // does with a directory path and flags 'r' (real Node's own fsync-a-
  // directory support is platform-dependent -- works on Linux/macOS, EISDIR
  // on some others) is exactly what this passes through. @seald-io/nedb's
  // own crashSafeWriteFileLinesAsync fsyncs a directory's fd this way, and
  // already tolerates the platforms where opening one fails. For the ROOT
  // specifically (this.isRoot), `this.handle` is fs/root.ts's own fake,
  // whose sync() already resolves -- no branch needed here either.
  async sync (): Promise<void> { await guarded(async () => { await this.handle.sync() }) }

  /** Real Node's FileHandle#datasync -- fdatasync, a lighter-weight sync. orivon.fs's FileHandle contract has one durability primitive, not two (handles.ts's own FileHandle doc), so this is the same call as sync() under a second name, matching what a ported dependency expects to find. */
  async datasync (): Promise<void> { await guarded(async () => { await this.handle.sync() }) }

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

/** Node's default open flag, when the caller gives none. */
const DEFAULT_FLAGS = 'r'

export async function openHandle (path: PathLike, flags: string | null = DEFAULT_FLAGS, _mode?: number): Promise<NodeFileHandle> {
  return await NodeFileHandle.open(path, flags ?? DEFAULT_FLAGS)
}

// ---- callback fs.open/fs.read/fs.write/fs.close/fs.fstat/... ----------

/** `fs.open(path[, flags[, mode]], callback)`. The callback is always the last argument; `mode` is a POSIX permission bit this confined fs has nothing to set it on (fs/fs.ts's own `not-applicable` reasoning for chmod/chown), so it is accepted and ignored. */
export function open (path: PathLike, callback: NodeCallback<number>): void
export function open (path: PathLike, flags: string | null, callback: NodeCallback<number>): void
export function open (path: PathLike, flags: string | null, mode: number, callback: NodeCallback<number>): void
export function open (path: PathLike, ...args: readonly unknown[]): void {
  const callback = args[args.length - 1] as NodeCallback<number>
  const flags = args.length > 1 ? args[0] as string | null : null
  openHandle(path, flags).then(
    (handle) => callback(null, handle.fd),
    (error) => callback(error as Error)
  )
}

/** Node's own default when close is given no callback: success is silent, a failure is thrown where nothing can catch it, as an uncaught error. */
function throwUncaught (error: Error | null): void {
  if (error !== null) queueMicrotask(() => { throw error })
}

export function close (fd: number, callback: NodeCallback<void> = throwUncaught): void {
  const handle = openByFd.get(fd)
  if (handle === undefined) { callback(badFd('close')); return }
  handle.close().then(() => callback(null), (error) => callback(error as Error))
}

export function read (
  fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null,
  callback: (error: Error | null, bytesRead: number, buffer: Uint8Array) => void
): void {
  const handle = openByFd.get(fd)
  if (handle === undefined) { callback(badFd('read'), 0, buffer); return }
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
  if (handle === undefined) { callback(badFd('write'), 0, buffer); return }
  handle.write(buffer, offset, length, position).then(
    (result) => callback(null, result.bytesWritten, result.buffer),
    (error) => callback(error as Error, 0, buffer)
  )
}

export function fstat (fd: number, callback: NodeCallback<NodeStats>): void {
  const handle = openByFd.get(fd)
  if (handle === undefined) { callback(badFd('fstat')); return }
  handle.stat().then((stat) => callback(null, stat), (error) => callback(error as Error))
}

export function ftruncate (fd: number, callback: NodeCallback<void>): void
export function ftruncate (fd: number, length: number, callback: NodeCallback<void>): void
export function ftruncate (fd: number, ...args: readonly unknown[]): void {
  const callback = args[args.length - 1] as NodeCallback<void>
  const length = args.length > 1 ? args[0] as number : 0
  const handle = openByFd.get(fd)
  if (handle === undefined) { callback(badFd('ftruncate')); return }
  handle.truncate(length).then(() => callback(null), (error) => callback(error as Error))
}

export function fsync (fd: number, callback: NodeCallback<void>): void {
  const handle = openByFd.get(fd)
  if (handle === undefined) { callback(badFd('fsync')); return }
  handle.sync().then(() => callback(null), (error) => callback(error as Error))
}
