// A synchronous `orivon.fs` twin over memory, installed where a Worker's
// would be (`Symbol.for('orivon.synchronous')`), so the whole file layer under
// a database -- confinement, handles, errors -- runs as it would in a Worker.
// It records every call, and a test can make a call throw to model a crash.

import type { Orivon } from '../../../../contracts/capability-api.js'
import type { SyncFileHandleWire, SyncOrivonFs } from '../../../fs/sync-orivon.js'

const SYNCHRONOUS = Symbol.for('orivon.synchronous')

interface MemoryFile { bytes: Uint8Array, length: number }

function orivonError (code: 'notFound' | 'exists', platformCode: string): Error {
  return Object.assign(new Error(`${platformCode} failure`), { name: 'OrivonError', code, platformCode })
}

export interface MemorySyncFs {
  readonly files: Map<string, MemoryFile>
  /** One entry per call: `open:<path>:<flags>`, `read`, `write`, `truncate`, `sync`, `stat`, `close`, `rm:<path>`. */
  readonly calls: string[]
  /** Bytes handed to `write`, in total. */
  bytesWritten: number
  /** Called before every call is served; throw from it to model a crash at that call. */
  hook: (call: string) => void
  install (): void
  uninstall (): void
  contents (path: string): Uint8Array | undefined
  /** A copy of the files as they are now: what a crash would leave. */
  snapshot (): Map<string, MemoryFile>
  restore (snapshot: Map<string, MemoryFile>): void
}

export function createMemorySyncFs (): MemorySyncFs {
  const files = new Map<string, MemoryFile>()
  const calls: string[] = []
  const self = { hook: (_call: string) => {}, bytesWritten: 0 }
  const record = (call: string): void => { calls.push(call); self.hook(call) }

  const handleFor = (file: MemoryFile): SyncFileHandleWire => ({
    read: ({ position, length }) => {
      record('read')
      return file.bytes.slice(Math.min(position, file.length), Math.min(position + length, file.length))
    },
    write: ({ position, data }) => {
      record('write')
      self.bytesWritten += data.length
      const end = position + data.length
      if (end > file.bytes.length) {
        const grown = new Uint8Array(Math.max(end, file.bytes.length * 2))
        grown.set(file.bytes.subarray(0, file.length))
        file.bytes = grown
      }
      if (position > file.length) file.bytes.fill(0, file.length, position)
      file.bytes.set(data, position)
      file.length = Math.max(file.length, end)
      return data.length
    },
    stat: () => { record('stat'); return { size: file.length, isFile: true, isDirectory: false, mtimeMs: 0 } },
    truncate: (length) => {
      record('truncate')
      if (length > file.bytes.length) {
        const grown = new Uint8Array(length)
        grown.set(file.bytes.subarray(0, file.length))
        file.bytes = grown
      } else file.bytes.fill(0, length, file.length)
      file.length = length
    },
    sync: () => { record('sync') },
    close: () => { record('close') }
  })

  const fs = {
    stat: (path: string) => {
      record(`stat:${path}`)
      const file = files.get(path)
      if (file === undefined) throw orivonError('notFound', 'ENOENT')
      return { size: file.length, isFile: true, isDirectory: false, mtimeMs: 0 }
    },
    mkdir: () => { record('mkdir') },
    rm: (path: string) => {
      record(`rm:${path}`)
      if (!files.delete(path)) throw orivonError('notFound', 'ENOENT')
    },
    open: (path: string, flags: string) => {
      record(`open:${path}:${flags}`)
      let file = files.get(path)
      if (flags === 'wx+') {
        if (file !== undefined) throw orivonError('exists', 'EEXIST')
        file = { bytes: new Uint8Array(0), length: 0 }
        files.set(path, file)
      } else if (file === undefined) throw orivonError('notFound', 'ENOENT')
      return handleFor(file)
    }
  } as unknown as SyncOrivonFs

  const clone = (source: Map<string, MemoryFile>): Map<string, MemoryFile> =>
    new Map([...source].map(([path, file]) => [path, { bytes: file.bytes.slice(), length: file.length }]))

  return {
    files,
    calls,
    get bytesWritten () { return self.bytesWritten },
    set bytesWritten (value) { self.bytesWritten = value },
    get hook () { return self.hook },
    set hook (value) { self.hook = value },
    install () { (globalThis as { orivon?: unknown }).orivon = { [SYNCHRONOUS]: { fs } } as unknown as Orivon },
    uninstall () { delete (globalThis as { orivon?: unknown }).orivon },
    contents: (path) => { const file = files.get(path); return file === undefined ? undefined : file.bytes.slice(0, file.length) },
    snapshot: () => clone(files),
    restore (snapshot) { files.clear(); for (const [path, file] of clone(snapshot)) files.set(path, file) }
  }
}
