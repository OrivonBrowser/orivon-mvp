// wasi:filesystem over orivon.fs: a descriptor is a directory's confined
// path, or an open orivon.fs file handle. Each call runs the preview1 host's
// own operations (../wasi/path-ops.ts) through its asynchronous driver, so
// the two hosts resolve, refuse, retry a bare limit and stop on a revoked
// grant the same way; only the error's spelling differs.

import type { FileHandle, FileStat } from '../../contracts/handles.js'
import { toConfinedPath } from '../fs/paths.js'
import { HostContext, type WasiFs } from '../wasi/context.js'
import { runAsync } from '../wasi/drivers.js'
import { type Op, fsCall, handleCall } from '../wasi/effects.js'
import { errnoFor, errnoName } from '../wasi/errno.js'
import { PathError, type ResolvedPath, inodeFor, resolveGuestPath } from '../wasi/fds.js'
import { createDirectory, openPath, readlink, removeDirectory, renamePath, statPath, unlinkFile } from '../wasi/path-ops.js'
import { EMPTY_STDIN } from '../wasi/stdio.js'
import { isTermination } from '../wasi/termination.js'
import { msToNs } from '../wasi/time.js'
import { type ErrorCode, InputStream, type IoError, OutputStream } from './io.js'

export type DescriptorType = 'unknown' | 'directory' | 'regular-file'

export interface DescriptorFlags { read?: boolean, write?: boolean, mutateDirectory?: boolean }
interface OpenFlags { create?: boolean, directory?: boolean, exclusive?: boolean, truncate?: boolean }
interface Datetime { seconds: bigint, nanoseconds: number }

export interface DescriptorStat {
  type: DescriptorType
  linkCount: bigint
  size: bigint
  dataAccessTimestamp?: Datetime
  dataModificationTimestamp?: Datetime
  statusChangeTimestamp?: Datetime
}

/** preview1's errno names, as WASI 0.2's filesystem error codes. */
const CODE_BY_ERRNO_NAME: Readonly<Record<string, string>> = {
  ACCES: 'access', AGAIN: 'would-block', ALREADY: 'already', BADF: 'bad-descriptor', BUSY: 'busy',
  DEADLK: 'deadlock', DQUOT: 'quota', EXIST: 'exist', FBIG: 'file-too-large', ILSEQ: 'illegal-byte-sequence',
  INPROGRESS: 'in-progress', INTR: 'interrupted', INVAL: 'invalid', IO: 'io', ISDIR: 'is-directory',
  LOOP: 'loop', MLINK: 'too-many-links', MSGSIZE: 'message-size', NAMETOOLONG: 'name-too-long',
  NODEV: 'no-device', NOENT: 'no-entry', NOLCK: 'no-lock', NOMEM: 'insufficient-memory',
  NOSPC: 'insufficient-space', NOTDIR: 'not-directory', NOTEMPTY: 'not-empty', NOTRECOVERABLE: 'not-recoverable',
  NOTSUP: 'unsupported', NOSYS: 'unsupported', NOTTY: 'no-tty', NXIO: 'no-such-device', OVERFLOW: 'overflow',
  PERM: 'not-permitted', PIPE: 'pipe', ROFS: 'read-only', SPIPE: 'invalid-seek', TXTBSY: 'text-file-busy',
  XDEV: 'cross-device', NOTCAPABLE: 'not-permitted'
}

/** An orivon.fs rejection or a path refusal, as the error code the component sees. */
export function errorCodeOf (error: unknown): string {
  const errno = error instanceof PathError ? error.errno : errnoFor(error)
  return CODE_BY_ERRNO_NAME[errnoName(errno) ?? ''] ?? 'io'
}

const filesystemCode = (error: unknown): ErrorCode => ({ kind: 'filesystem', code: errorCodeOf(error) })

function datetimeOf (ms: number): Datetime {
  const ns = msToNs(ms)
  return { seconds: ns / 1_000_000_000n, nanoseconds: Number(ns % 1_000_000_000n) }
}

function statOf (stat: FileStat): DescriptorStat {
  return {
    type: stat.isDirectory ? 'directory' : stat.isFile ? 'regular-file' : 'unknown',
    linkCount: 1n,
    size: BigInt(stat.size),
    dataModificationTimestamp: datetimeOf(stat.mtimeMs)
  }
}

type Target =
  | { readonly kind: 'directory', readonly path: string }
  | { readonly kind: 'file', readonly path: string, readonly handle: FileHandle, readonly flags: DescriptorFlags }

export class DirectoryEntryStream {
  readonly #entries: Array<{ type: DescriptorType, name: string }>

  constructor (entries: Array<{ type: DescriptorType, name: string }>) {
    this.#entries = entries
  }

  readDirectoryEntry (): { type: DescriptorType, name: string } | undefined {
    return this.#entries.shift()
  }
}

export class Descriptor {
  readonly #ctx: HostContext
  readonly #target: Target

  constructor (ctx: HostContext, target: Target) {
    this.#ctx = ctx
    this.#target = target
  }

  /**
   * Runs one operation. Its refusal is thrown as the error code, which the
   * glue lowers as the result's error; a revoked grant stays a termination
   * and unwinds the component, as the preview1 host stops a program.
   */
  async #run<T> (op: Op<T>): Promise<T> {
    try {
      return await runAsync(this.#ctx, op)
    } catch (error) {
      if (isTermination(error)) throw error
      throw errorCodeOf(error)
    }
  }

  #file (): Extract<Target, { kind: 'file' }> {
    if (this.#target.kind !== 'file') throw 'is-directory'
    return this.#target
  }

  #readable (): FileHandle {
    const { handle, flags } = this.#file()
    if (flags.read !== true) throw 'bad-descriptor'
    return handle
  }

  #writable (): FileHandle {
    const { handle, flags } = this.#file()
    if (flags.write !== true) throw 'bad-descriptor'
    return handle
  }

  #resolve (path: string): ResolvedPath {
    if (this.#target.kind !== 'directory') throw 'not-directory'
    try {
      return resolveGuestPath({ kind: 'directory', path: this.#target.path }, path)
    } catch (error) {
      throw errorCodeOf(error)
    }
  }

  readViaStream (offset: bigint): InputStream {
    const handle = this.#readable()
    let position = Number(offset)
    return new InputStream(async (max) => {
      const data = await runAsync(this.#ctx, handleCall<Uint8Array>(handle, 'read', { position, length: max }))
      position += data.length
      return data
    }, filesystemCode)
  }

  writeViaStream (offset: bigint): OutputStream {
    return this.#writer(Number(offset), false)
  }

  appendViaStream (): OutputStream {
    return this.#writer(0, true)
  }

  #writer (start: number, append: boolean): OutputStream {
    const handle = this.#writable()
    const ctx = this.#ctx
    let position = start
    return new OutputStream(async (bytes) => {
      await runAsync(ctx, (function * (): Op<void> {
        if (append) position = (yield * handleCall<FileStat>(handle, 'stat')).size
        for (let written = 0; written < bytes.length;) {
          const count = yield * handleCall<number>(handle, 'write', { position, data: bytes.subarray(written) })
          position += count
          written += count
        }
      })())
    }, filesystemCode)
  }

  advise (): void {}

  async syncData (): Promise<void> {
    await this.sync()
  }

  async sync (): Promise<void> {
    if (this.#target.kind === 'file') await this.#run(handleCall(this.#target.handle, 'sync'))
  }

  getFlags (): DescriptorFlags {
    return this.#target.kind === 'file' ? this.#target.flags : { read: true, mutateDirectory: true }
  }

  getType (): DescriptorType {
    return this.#target.kind === 'file' ? 'regular-file' : 'directory'
  }

  async setSize (size: bigint): Promise<void> {
    await this.#run(handleCall(this.#writable(), 'truncate', Number(size)))
  }

  async read (length: bigint, offset: bigint): Promise<[Uint8Array, boolean]> {
    const data = await this.#run(handleCall<Uint8Array>(this.#readable(), 'read', { position: Number(offset), length: Number(length) }))
    return [data, data.length < Number(length)]
  }

  async write (buffer: Uint8Array, offset: bigint): Promise<bigint> {
    return BigInt(await this.#run(handleCall<number>(this.#writable(), 'write', { position: Number(offset), data: buffer.slice() })))
  }

  /** A snapshot, typed by a stat of each entry; `.` and `..` are not listed, as WASI 0.2 specifies. */
  async readDirectory (): Promise<DirectoryEntryStream> {
    if (this.#target.kind !== 'directory') throw 'not-directory'
    const { path } = this.#target
    const ctx = this.#ctx
    const names = await this.#run(fsCall<readonly string[]>('readdir', path))
    const entries = await Promise.all(names.map(async (name) => {
      const stat = await this.#run(ctx.statIfExists(path === '.' ? name : `${path}/${name}`))
      return { type: stat === undefined ? 'unknown' as const : statOf(stat).type, name }
    }))
    return new DirectoryEntryStream(entries)
  }

  async createDirectoryAt (path: string): Promise<void> {
    await this.#run(createDirectory(this.#resolve(path)))
  }

  async stat (): Promise<DescriptorStat> {
    if (this.#target.kind === 'file') return statOf(await this.#run(handleCall<FileStat>(this.#target.handle, 'stat')))
    return statOf(await this.#run(this.#ctx.stat(this.#target.path)))
  }

  async statAt (_pathFlags: unknown, path: string): Promise<DescriptorStat> {
    return statOf(await this.#run(statPath(this.#ctx, this.#resolve(path))))
  }

  setTimes (): never { throw 'unsupported' }
  setTimesAt (): never { throw 'unsupported' }
  linkAt (): never { throw 'unsupported' }
  symlinkAt (): never { throw 'unsupported' }

  async readlinkAt (path: string): Promise<string> {
    return await this.#run(readlink(this.#ctx, this.#resolve(path)))
  }

  async openAt (_pathFlags: unknown, path: string, open: OpenFlags, flags: DescriptorFlags): Promise<Descriptor> {
    const resolved = this.#resolve(path)
    const write = flags.write === true || open.truncate === true
    const intent = { read: flags.read === true || !write, write, creat: open.create === true, excl: open.exclusive === true, trunc: open.truncate === true }
    const opened = await this.#run(openPath(this.#ctx, resolved, intent, open.directory === true))
    return new Descriptor(this.#ctx, opened.kind === 'directory'
      ? { kind: 'directory', path: resolved.path }
      : { kind: 'file', path: resolved.path, handle: opened.handle as FileHandle, flags: { read: intent.read, write } })
  }

  async removeDirectoryAt (path: string): Promise<void> {
    await this.#run(removeDirectory(this.#ctx, this.#resolve(path)))
  }

  async renameAt (oldPath: string, target: Descriptor, newPath: string): Promise<void> {
    await this.#run(renamePath(this.#ctx, this.#resolve(oldPath), target.#resolve(newPath)))
  }

  async unlinkFileAt (path: string): Promise<void> {
    await this.#run(unlinkFile(this.#ctx, this.#resolve(path)))
  }

  isSameObject (other: Descriptor): boolean {
    return other.#target.path === this.#target.path
  }

  async metadataHash (): Promise<{ lower: bigint, upper: bigint }> {
    return hashOf(this.#target.path, await this.stat())
  }

  async metadataHashAt (pathFlags: unknown, path: string): Promise<{ lower: bigint, upper: bigint }> {
    return hashOf(this.#resolve(path).path, await this.statAt(pathFlags, path))
  }

  [Symbol.dispose] (): void {
    if (this.#target.kind === 'file') void this.#target.handle.close().catch(() => {})
  }
}

function hashOf (path: string, stat: DescriptorStat): { lower: bigint, upper: bigint } {
  const modified = stat.dataModificationTimestamp
  return { lower: inodeFor(path), upper: BigInt.asUintN(64, stat.size ^ (modified === undefined ? 0n : modified.seconds * 1_000_000_000n + BigInt(modified.nanoseconds))) }
}

export function filesystemInterfaces (fs: WasiFs, preopens: Readonly<Record<string, string>>): Record<string, Record<string, unknown>> {
  const ctx = new HostContext(fs, [], [], EMPTY_STDIN, () => {}, () => {})
  const directories = Object.entries(preopens).map(([name, virtualPath]): [Descriptor, string] =>
    [new Descriptor(ctx, { kind: 'directory', path: toConfinedPath(virtualPath, 'wasi preopen') }), name])
  return {
    'wasi:filesystem/types': {
      Descriptor,
      DirectoryEntryStream,
      filesystemErrorCode: (error: IoError): string | undefined => error.codeFor('filesystem')
    },
    'wasi:filesystem/preopens': { getDirectories: (): Array<[Descriptor, string]> => directories }
  }
}
