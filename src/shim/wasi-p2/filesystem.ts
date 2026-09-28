// wasi:filesystem over orivon.fs: a descriptor is a directory's confined
// path, or an open orivon.fs file handle. Every call is an orivon.fs call the
// app could already make. Paths resolve as the preview1 host resolves them
// (../wasi/fds.ts), and errors map through its errno table, so the two
// hosts refuse the same things the same way.

import type { FileHandle, FileStat } from '../../contracts/handles.js'
import { toConfinedPath } from '../fs/paths.js'
import { isRootPath, rootStat } from '../fs/root.js'
import type { WasiFs } from '../wasi/context.js'
import { errnoFor, errnoName } from '../wasi/errno.js'
import { PathError, type ResolvedPath, inodeFor, resolveGuestPath } from '../wasi/fds.js'
import { openFlags } from '../wasi/preview1/path.js'
import { InputStream, type IoError, OutputStream } from './io.js'

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

/** Runs one orivon.fs call; its failure is thrown as the error code, which the glue lowers as the result's error. */
async function attempt<T> (run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw errorCodeOf(error)
  }
}

function datetimeOf (ms: number): Datetime {
  const seconds = Math.floor(ms / 1000)
  return { seconds: BigInt(seconds), nanoseconds: Math.round((ms - seconds * 1000) * 1_000_000) }
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
  readonly #fs: WasiFs
  readonly #target: Target

  constructor (fs: WasiFs, target: Target) {
    this.#fs = fs
    this.#target = target
  }

  #file (): Extract<Target, { kind: 'file' }> {
    if (this.#target.kind !== 'file') throw 'is-directory'
    return this.#target
  }

  #resolve (path: string): ResolvedPath {
    if (this.#target.kind !== 'directory') throw 'not-directory'
    try {
      return resolveGuestPath({ kind: 'directory', path: this.#target.path }, path)
    } catch (error) {
      throw errorCodeOf(error)
    }
  }

  async #stat (path: string): Promise<FileStat> {
    return isRootPath(path) ? rootStat() : await attempt(async () => await this.#fs.stat(path))
  }

  async #statIfExists (path: string): Promise<FileStat | undefined> {
    try {
      return await this.#stat(path)
    } catch (code) {
      if (code === 'no-entry') return undefined
      throw code
    }
  }

  readViaStream (offset: bigint): InputStream {
    const { handle, flags } = this.#file()
    if (flags.read !== true) throw 'bad-descriptor'
    let position = Number(offset)
    return new InputStream(async (max) => {
      const data = await handle.read({ position, length: max })
      position += data.length
      return data
    }, errorCodeOf)
  }

  writeViaStream (offset: bigint): OutputStream {
    return this.#writer(() => Number(offset), false)
  }

  appendViaStream (): OutputStream {
    return this.#writer(() => 0, true)
  }

  #writer (start: () => number, append: boolean): OutputStream {
    const { handle, flags } = this.#file()
    if (flags.write !== true) throw 'bad-descriptor'
    let position = start()
    return new OutputStream(async (bytes) => {
      if (append) position = (await handle.stat()).size
      for (let written = 0; written < bytes.length;) {
        const count = await handle.write({ position, data: bytes.subarray(written) })
        position += count
        written += count
      }
    }, errorCodeOf)
  }

  advise (): void {}

  async syncData (): Promise<void> {
    await this.sync()
  }

  async sync (): Promise<void> {
    if (this.#target.kind === 'file') { const { handle } = this.#target; await attempt(async () => { await handle.sync() }) }
  }

  getFlags (): DescriptorFlags {
    return this.#target.kind === 'file' ? this.#target.flags : { read: true, mutateDirectory: true }
  }

  getType (): DescriptorType {
    return this.#target.kind === 'file' ? 'regular-file' : 'directory'
  }

  async setSize (size: bigint): Promise<void> {
    const { handle, flags } = this.#file()
    if (flags.write !== true) throw 'bad-descriptor'
    await attempt(async () => { await handle.truncate(Number(size)) })
  }

  async read (length: bigint, offset: bigint): Promise<[Uint8Array, boolean]> {
    const { handle, flags } = this.#file()
    if (flags.read !== true) throw 'bad-descriptor'
    const data = await attempt(async () => await handle.read({ position: Number(offset), length: Number(length) }))
    return [data, data.length < Number(length)]
  }

  async write (buffer: Uint8Array, offset: bigint): Promise<bigint> {
    const { handle, flags } = this.#file()
    if (flags.write !== true) throw 'bad-descriptor'
    return BigInt(await attempt(async () => await handle.write({ position: Number(offset), data: buffer.slice() })))
  }

  /** A snapshot, typed by a stat of each entry; `.` and `..` are not listed, as WASI 0.2 specifies. */
  async readDirectory (): Promise<DirectoryEntryStream> {
    if (this.#target.kind !== 'directory') throw 'not-directory'
    const { path } = this.#target
    const names = await attempt(async () => await this.#fs.readdir(path))
    const entries = await Promise.all(names.map(async (name) => {
      const stat = await this.#statIfExists(path === '.' ? name : `${path}/${name}`)
      return { type: stat === undefined ? 'unknown' as const : statOf(stat).type, name }
    }))
    return new DirectoryEntryStream(entries)
  }

  async createDirectoryAt (path: string): Promise<void> {
    const resolved = this.#resolve(path)
    if (isRootPath(resolved.path)) throw 'exist'
    await attempt(async () => { await this.#fs.mkdir(resolved.path) })
  }

  async stat (): Promise<DescriptorStat> {
    if (this.#target.kind === 'file') { const { handle } = this.#target; return statOf(await attempt(async () => await handle.stat())) }
    return statOf(await this.#stat(this.#target.path))
  }

  async statAt (_pathFlags: unknown, path: string): Promise<DescriptorStat> {
    const resolved = this.#resolve(path)
    const stat = await this.#stat(resolved.path)
    if (resolved.trailingSlash && !stat.isDirectory) throw 'not-directory'
    return statOf(stat)
  }

  setTimes (): never { throw 'unsupported' }
  setTimesAt (): never { throw 'unsupported' }
  linkAt (): never { throw 'unsupported' }
  symlinkAt (): never { throw 'unsupported' }

  /** orivon.fs has no links, so an existing name is never one: POSIX's EINVAL. */
  async readlinkAt (path: string): Promise<string> {
    await this.#stat(this.#resolve(path).path)
    throw 'invalid'
  }

  async openAt (_pathFlags: unknown, path: string, open: OpenFlags, flags: DescriptorFlags): Promise<Descriptor> {
    const resolved = this.#resolve(path)
    const existing = await this.#statIfExists(resolved.path)
    if (resolved.trailingSlash && existing !== undefined && !existing.isDirectory) throw 'not-directory'
    if (open.create === true && open.exclusive === true && existing !== undefined) throw 'exist'
    const write = flags.write === true || open.truncate === true
    if (existing?.isDirectory === true) {
      if (write) throw 'is-directory'
      return new Descriptor(this.#fs, { kind: 'directory', path: resolved.path })
    }
    if (open.directory === true) throw existing === undefined ? 'no-entry' : 'not-directory'
    if (existing === undefined && open.create !== true) throw 'no-entry'
    const intent = { read: flags.read === true || !write, write, creat: open.create === true, excl: open.exclusive === true, trunc: open.truncate === true }
    const handle = await this.#open(resolved.path, intent, existing !== undefined)
    return new Descriptor(this.#fs, { kind: 'file', path: resolved.path, handle, flags: { read: intent.read, write } })
  }

  /** A file that appeared between the stat and a create without `exclusive` is simply opened, as path.ts's openFile does. */
  async #open (path: string, intent: Parameters<typeof openFlags>[0], exists: boolean): Promise<FileHandle> {
    try {
      return await this.#fs.open(path, openFlags(intent, exists))
    } catch (error) {
      const raced = !exists && !intent.excl && (error as { code?: unknown } | null)?.code === 'exists'
      if (!raced) throw errorCodeOf(error)
      return await attempt(async () => await this.#fs.open(path, openFlags({ ...intent, trunc: false }, true)))
    }
  }

  async removeDirectoryAt (path: string): Promise<void> {
    const resolved = this.#resolve(path)
    if (isRootPath(resolved.path)) throw 'invalid'
    const stat = await this.#stat(resolved.path)
    if (!stat.isDirectory) throw 'not-directory'
    if ((await attempt(async () => await this.#fs.readdir(resolved.path))).length > 0) throw 'not-empty'
    // orivon.fs.rm removes a directory only recursively; emptiness was checked above.
    await attempt(async () => { await this.#fs.rm(resolved.path, { recursive: true }) })
  }

  async renameAt (oldPath: string, target: Descriptor, newPath: string): Promise<void> {
    const from = this.#resolve(oldPath)
    const to = target.#resolve(newPath)
    if (isRootPath(from.path) || isRootPath(to.path)) throw 'access'
    const source = await this.#stat(from.path)
    if (to.trailingSlash && !source.isDirectory) throw 'not-directory'
    await attempt(async () => { await this.#fs.rename(from.path, to.path) })
  }

  async unlinkFileAt (path: string): Promise<void> {
    const resolved = this.#resolve(path)
    if (isRootPath(resolved.path)) throw 'is-directory'
    const stat = await this.#stat(resolved.path)
    if (stat.isDirectory) throw 'is-directory'
    if (resolved.trailingSlash) throw 'not-directory'
    await attempt(async () => { await this.#fs.rm(resolved.path) })
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
  const directories = Object.entries(preopens).map(([name, virtualPath]): [Descriptor, string] =>
    [new Descriptor(fs, { kind: 'directory', path: toConfinedPath(virtualPath, 'wasi preopen') }), name])
  return {
    'wasi:filesystem/types': {
      Descriptor,
      DirectoryEntryStream,
      filesystemErrorCode: (error: IoError): string | undefined => error.code
    },
    'wasi:filesystem/preopens': { getDirectories: (): Array<[Descriptor, string]> => directories }
  }
}
