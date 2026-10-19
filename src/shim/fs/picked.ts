// What the asynchronous fs calls do with a stand-in path (shim-electron/picked-paths.ts): the file or folder
// the person picked is reached through the pick's own handle, and nothing else. Each call in core.ts and
// handle.ts asks `pickedTarget` first; a path outside the picked root answers `undefined` and takes the
// app-root route unchanged. README.md's Design notes, "Picked paths", has the shape and the reasons.

import { normalize } from 'path/posix'
import type { DirectoryHandle, FileHandle, FileStat } from '../../contracts/handles.js'
import { resolvePickedPath, type PickedEntry } from '../../shim-electron/picked-paths.js'
import { fsError, guarded, pathText, type PathLike } from './paths.js'
import {
  assertRootMkdirAllowed, assertRootOpenAllowed, rootDirectoryHandle, rootIsDirectoryError
} from './root.js'
import { openFlagged } from './flags.js'

/** The size a read asks of the pick's handle at a time. */
const READ_CHUNK = 1024 * 1024

interface PickedOps {
  readonly stat: (rel: string) => Promise<FileStat>
  readonly readdir: (rel: string) => Promise<readonly string[]>
  readonly mkdir: (rel: string, opts: { recursive?: boolean } | undefined) => Promise<void>
  readonly rm: (rel: string, opts: { recursive?: boolean } | undefined) => Promise<void>
  readonly rename: (from: string, to: string) => Promise<void>
  readonly readFile: (rel: string) => Promise<Uint8Array>
  readonly writeFile: (rel: string, data: Uint8Array) => Promise<void>
  readonly open: (rel: string, flags: string) => Promise<FileHandle>
}

export interface PickedTarget {
  readonly id: string
  readonly ops: PickedOps
  /** Where the path points inside the pick, `''` for the pick's own folder. */
  readonly rel: string
  /** The path as the caller wrote it, for the errors it reads. */
  readonly text: string
  /** The stand-in path normalised: what the pick is known by (a stat's `ino`, a realpath). */
  readonly path: string
}

export function stalePickError (syscall: string, path: string): Error {
  return fsError('ENOENT',
    'no such file or directory (the pick behind this path did not survive a reload, or was revoked: ask the person to pick it again)',
    syscall, path)
}

function listError (syscall: string, path: string): Error {
  return fsError('EACCES', 'permission denied (picked paths cannot be listed: use the path the dialog returned)', syscall, path)
}

/** Reads one part of a pick as bytes, in chunks. */
async function readAll (handle: FileHandle): Promise<Uint8Array> {
  const size = (await guarded(async () => await handle.stat())).size
  const out = new Uint8Array(size)
  let at = 0
  while (at < size) {
    const bytes = await guarded(async () => await handle.read({ position: at, length: Math.min(READ_CHUNK, size - at) }))
    if (bytes.length === 0) return out.subarray(0, at)
    out.set(bytes, at)
    at += bytes.length
  }
  return out
}

async function writeAll (handle: FileHandle, data: Uint8Array): Promise<void> {
  for (let at = 0; at < data.length; at += READ_CHUNK) {
    const part = data.subarray(at, Math.min(at + READ_CHUNK, data.length))
    await guarded(async () => await handle.write({ position: at, data: part }))
  }
}

/** A pick's file handle opened for one `fs.open`: closing it flushes (a save target commits there) and leaves the pick itself open. */
function sharedOpen (handle: FileHandle, flags: string): FileHandle {
  const writes = /[wa+]/.test(flags)
  return {
    id: handle.id,
    closed: handle.closed,
    close: async () => { if (writes) await handle.sync() },
    read: async (opts) => await handle.read(opts),
    write: async (opts) => await handle.write(opts),
    // A page's handle has no streams yet (A184); these are asked only if a caller reaches for them.
    readable: (opts) => handle.readable(opts),
    writable: (opts) => handle.writable(opts),
    stat: async () => await handle.stat(),
    truncate: async (length) => { await handle.truncate(length) },
    sync: async () => { await handle.sync() }
  }
}

function folderRootError (syscall: string): Error {
  return fsError('EACCES', 'permission denied (a picked folder itself cannot be removed or moved)', syscall)
}

function directoryOps (handle: DirectoryHandle): PickedOps {
  const root = (rel: string): string | undefined => (rel === '' ? undefined : rel)
  return {
    stat: async (rel) => await guarded(async () => await handle.stat(root(rel))),
    readdir: async (rel) => await guarded(async () => await handle.readdir(root(rel))),
    mkdir: async (rel, opts) => {
      if (rel === '') { assertRootMkdirAllowed(opts); return }
      await guarded(async () => { await handle.mkdir(rel, opts) })
    },
    rm: async (rel, opts) => {
      if (rel === '') throw folderRootError('rm')
      await guarded(async () => { await handle.rm(rel, opts) })
    },
    rename: async (from, to) => {
      if (from === '' || to === '') throw folderRootError('rename')
      await guarded(async () => { await handle.rename(from, to) })
    },
    readFile: async (rel) => {
      if (rel === '') rootIsDirectoryError('read')
      return await guarded(async () => await handle.readFile(rel))
    },
    writeFile: async (rel, data) => {
      if (rel === '') rootIsDirectoryError('open')
      await guarded(async () => { await handle.writeFile(rel, data) })
    },
    open: async (rel, flags) => {
      if (rel === '') { assertRootOpenAllowed(flags); return rootDirectoryHandle() }
      return await guarded(async () => await handle.open(rel, flags))
    }
  }
}

function fileOps (entry: Extract<PickedEntry, { kind: 'file' }>): PickedOps {
  const { handle, name } = entry
  const folderOnly = (syscall: string, rel: string): Error =>
    fsError('EACCES', "permission denied (a picked file's folder holds only that file)", syscall, rel)
  const missing = (syscall: string, rel: string): Error => fsError('ENOENT', 'no such file or directory', syscall, rel)
  const folderStat = async (): Promise<FileStat> => {
    const file = await guarded(async () => await handle.stat())
    return { size: 0, isFile: false, isDirectory: true, mtimeMs: file.mtimeMs }
  }
  return {
    stat: async (rel) => {
      if (rel === '') return await folderStat()
      if (rel === name) return await guarded(async () => await handle.stat())
      throw missing('stat', rel)
    },
    readdir: async (rel) => {
      if (rel === '') return [name]
      throw rel === name ? fsError('ENOTDIR', 'not a directory', 'scandir', rel) : missing('scandir', rel)
    },
    mkdir: async (rel, opts) => {
      if (rel === '') { assertRootMkdirAllowed(opts); return }
      if (rel === name) throw fsError('EEXIST', 'file already exists', 'mkdir', rel)
      throw folderOnly('mkdir', rel)
    },
    rm: async (rel) => {
      if (rel === '' || rel === name) throw fsError('EACCES', 'permission denied (a picked file cannot be removed from here: write it empty instead)', 'rm', rel)
      throw missing('rm', rel)
    },
    rename: async (from) => { throw fsError('EACCES', 'permission denied (a picked file cannot be renamed or replaced by a rename)', 'rename', from) },
    readFile: async (rel) => {
      if (rel === '') rootIsDirectoryError('read')
      if (rel !== name) throw missing('open', rel)
      return await readAll(handle)
    },
    writeFile: async (rel, data) => {
      if (rel === '') rootIsDirectoryError('open')
      if (rel !== name) throw folderOnly('open', rel)
      await guarded(async () => { await handle.truncate(0) })
      await writeAll(handle, data)
      await guarded(async () => { await handle.sync() })
    },
    open: async (rel, flags) => {
      if (rel === '') { assertRootOpenAllowed(flags); return rootDirectoryHandle() }
      if (rel !== name) throw (/^[wa]/.test(flags) ? folderOnly('open', rel) : missing('open', rel))
      if (flags.includes('x')) throw fsError('EEXIST', 'file already exists', 'open', rel)
      if (flags.startsWith('w')) await guarded(async () => { await handle.truncate(0) })
      return sharedOpen(handle, flags)
    }
  }
}

/**
 * What `path` names among the picks, or `undefined` when it is not under the picked root. A path under the root
 * that no pick answers (a reload dropped it) throws the Node-shaped error that says to pick again; the list
 * itself is refused.
 */
export function pickedTarget (path: PathLike, syscall: string): PickedTarget | undefined {
  const text = pathText(path)
  const resolved = resolvePickedPath(text)
  if (resolved === undefined) return undefined
  if (resolved.status === 'list') throw listError(syscall, text)
  if (resolved.status === 'stale') throw stalePickError(syscall, text)
  const { entry, relative } = resolved
  return {
    id: entry.id,
    ops: entry.kind === 'file' ? fileOps(entry) : directoryOps(entry.handle),
    rel: relative,
    text,
    path: normalize(text).replace(/(.)\/+$/, '$1')
  }
}

export async function pickedReadFile (target: PickedTarget): Promise<Uint8Array> {
  return await target.ops.readFile(target.rel)
}

export async function pickedWriteFile (target: PickedTarget, data: Uint8Array): Promise<void> {
  await target.ops.writeFile(target.rel, data)
}

export async function pickedStat (target: PickedTarget): Promise<FileStat> {
  return await target.ops.stat(target.rel)
}

export async function pickedReaddir (target: PickedTarget): Promise<readonly string[]> {
  return await target.ops.readdir(target.rel)
}

export async function pickedMkdir (target: PickedTarget, opts: { recursive?: boolean } | undefined): Promise<void> {
  await target.ops.mkdir(target.rel, opts)
}

export async function pickedRm (target: PickedTarget, opts: { recursive?: boolean } | undefined): Promise<void> {
  await target.ops.rm(target.rel, opts)
}

/** A rename inside one pick; across two picks, or between a pick and the app's files, it is a different device. */
export async function pickedRename (from: PickedTarget | undefined, to: PickedTarget | undefined, fromText: string): Promise<void> {
  if (from === undefined || to === undefined || from.id !== to.id) {
    throw fsError('EXDEV', 'cross-device link not permitted (a pick is a separate place from the app\'s files and from every other pick)', 'rename', fromText)
  }
  await from.ops.rename(from.rel, to.rel)
}

/** `fs.open` on a pick: the handle `NodeFileHandle` wraps. A folder opens read-only as a directory; a file shares the pick's handle. */
export async function pickedOpen (target: PickedTarget, flags: string): Promise<FileHandle> {
  return await openFlagged(async (rel, mode) => await target.ops.open(rel, mode), target.rel, flags)
}

/** Node's legacy rmdir over a pick: the same ENOENT, ENOTDIR and ENOTEMPTY checks core.ts's doRmdir makes before it removes anything. */
export async function pickedRmdir (target: PickedTarget, opts: { recursive?: boolean } | undefined): Promise<void> {
  if (opts?.recursive === true) { await target.ops.rm(target.rel, { recursive: true }); return }
  const stat = await target.ops.stat(target.rel)
  if (!stat.isDirectory) throw fsError('ENOTDIR', 'not a directory', 'rmdir', target.text)
  if ((await target.ops.readdir(target.rel)).length > 0) throw fsError('ENOTEMPTY', 'directory not empty', 'rmdir', target.text)
  await target.ops.rm(target.rel, { recursive: true })
}
