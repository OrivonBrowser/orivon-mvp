// A fake DirectoryHandle (src/contracts/handles.ts) over an in-memory tree, for exercising a picked folder
// through fs/picked.ts without a broker. It refuses a path that leaves its root the way the broker does
// ('denied'), and reports a missing path as the broker's 'notFound' with an ENOENT platformCode, so the shim's
// error mapping is the real one. Every call it receives is recorded.

import type { DirectoryHandle, FileHandle, FileStat } from '../../../contracts/handles.js'
import { createFakeFileHandle } from './fake-file-handle.js'

export interface FakeDirectoryHandle {
  readonly handle: DirectoryHandle
  /** Every call as `method path`, in order. */
  readonly calls: string[]
  /** The bytes of a file by path relative to the folder, or `undefined` when it is missing. */
  bytes (path: string): Uint8Array | undefined
  put (path: string, text: string): void
  has (path: string): boolean
}

function failure (code: string, platformCode: string | undefined, message: string): Error {
  return Object.assign(new Error(message), { code, platformCode })
}

export function createFakeDirectoryHandle (): FakeDirectoryHandle {
  const files = new Map<string, Uint8Array>()
  const dirs = new Set<string>([''])
  const calls: string[] = []

  const confine = (path: string): string => {
    if (path.startsWith('/') || path.split('/').includes('..')) throw failure('denied', undefined, 'the path is outside the picked folder')
    return path
  }
  const parentOf = (path: string): string => path.split('/').slice(0, -1).join('/')
  const statOf = (path: string): FileStat => {
    const bytes = files.get(path)
    if (bytes !== undefined) return { size: bytes.length, isFile: true, isDirectory: false, mtimeMs: 1 }
    if (dirs.has(path)) return { size: 0, isFile: false, isDirectory: true, mtimeMs: 1 }
    throw failure('notFound', 'ENOENT', `ENOENT: no such file or directory, stat '${path}'`)
  }

  const handle: DirectoryHandle = {
    id: 'fake-directory-handle',
    closed: new Promise(() => {}),
    close: async () => {},
    readdir: async (path) => {
      calls.push(`readdir ${path ?? ''}`)
      const at = path === undefined ? '' : confine(path)
      if (!dirs.has(at)) throw failure('notFound', 'ENOENT', `ENOENT: no such file or directory, scandir '${at}'`)
      const names = new Set<string>()
      for (const entry of [...files.keys(), ...dirs]) if (entry !== '' && parentOf(entry) === at) names.add(entry.split('/').at(-1) as string)
      return [...names].sort()
    },
    stat: async (path) => { calls.push(`stat ${path ?? ''}`); return statOf(path === undefined ? '' : confine(path)) },
    mkdir: async (path, opts) => {
      calls.push(`mkdir ${path}`)
      const at = confine(path)
      if (dirs.has(at) || files.has(at)) {
        if (opts?.recursive === true && dirs.has(at)) return
        throw failure('exists', 'EEXIST', `EEXIST: file already exists, mkdir '${at}'`)
      }
      if (!dirs.has(parentOf(at)) && opts?.recursive !== true) throw failure('notFound', 'ENOENT', `ENOENT: no such file or directory, mkdir '${at}'`)
      let built = ''
      for (const part of at.split('/')) { built = built === '' ? part : `${built}/${part}`; dirs.add(built) }
    },
    rm: async (path, opts) => {
      calls.push(`rm ${path}`)
      const at = confine(path)
      if (files.delete(at)) return
      if (!dirs.has(at)) throw failure('notFound', 'ENOENT', `ENOENT: no such file or directory, rm '${at}'`)
      if (opts?.recursive !== true) throw failure('invalid', 'ERR_FS_EISDIR', 'Path is a directory')
      for (const entry of [...files.keys()]) if (entry.startsWith(`${at}/`)) files.delete(entry)
      for (const entry of [...dirs]) if (entry === at || entry.startsWith(`${at}/`)) dirs.delete(entry)
    },
    rename: async (from, to) => {
      calls.push(`rename ${from} ${to}`)
      const source = confine(from)
      const target = confine(to)
      const bytes = files.get(source)
      if (bytes === undefined) throw failure('notFound', 'ENOENT', `ENOENT: no such file or directory, rename '${source}'`)
      files.delete(source)
      files.set(target, bytes)
    },
    readFile: async (path) => {
      calls.push(`readFile ${path}`)
      const bytes = files.get(confine(path))
      if (bytes === undefined) throw failure('notFound', 'ENOENT', `ENOENT: no such file or directory, open '${path}'`)
      return bytes
    },
    writeFile: async (path, data) => {
      calls.push(`writeFile ${path}`)
      const at = confine(path)
      if (!dirs.has(parentOf(at))) throw failure('notFound', 'ENOENT', `ENOENT: no such file or directory, open '${at}'`)
      files.set(at, data.slice())
    },
    open: async (path, flags): Promise<FileHandle> => {
      calls.push(`open ${path} ${flags}`)
      const at = confine(path)
      const existing = files.get(at)
      if (existing === undefined && !/^[wa]/.test(flags)) throw failure('notFound', 'ENOENT', `ENOENT: no such file or directory, open '${at}'`)
      if (existing !== undefined && flags.includes('x')) throw failure('exists', 'EEXIST', `EEXIST: file already exists, open '${at}'`)
      if (existing === undefined && !dirs.has(parentOf(at))) throw failure('notFound', 'ENOENT', `ENOENT: no such file or directory, open '${at}'`)
      const fake = createFakeFileHandle(flags.startsWith('w') || existing === undefined ? new Uint8Array(0) : existing.slice())
      const sync = fake.handle.sync
      const flush = (): void => { files.set(at, fake.bytes().slice()) }
      flush()
      return {
        ...fake.handle,
        write: async (opts) => { const written = await fake.handle.write(opts); flush(); return written },
        truncate: async (length) => { await fake.handle.truncate(length); flush() },
        sync: async () => { await sync(); flush() }
      }
    }
  }

  return {
    handle,
    calls,
    bytes: (path) => files.get(path),
    put: (path, text) => {
      let built = ''
      for (const part of path.split('/').slice(0, -1)) { built = built === '' ? part : `${built}/${part}`; dirs.add(built) }
      files.set(path, new TextEncoder().encode(text))
    },
    has: (path) => files.has(path) || dirs.has(path)
  }
}
