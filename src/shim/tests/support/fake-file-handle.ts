// A fake FileHandle (src/contracts/handles.ts) for exercising
// fs/handle.ts without a broker, a preload or an Electron launch.
// Positional reads/writes grow an in-memory Uint8Array exactly like a real
// file would; every call's own `position` is recorded, so a test can prove
// fs/handle.ts always sends an EXPLICIT position underneath -- this
// handle itself has no cursor of its own (handles.ts's own FileHandle doc
// comment: deliberately, there isn't one). Under tests/support/, not
// tests/, for the same reason fake-tcp-socket.ts is: vitest.config.ts's
// `include` only matches `*.test.ts`.

import type { FileHandle, FileStat } from '../../../contracts/handles.js'

export interface FakeFileHandleCall { position: number, length: number }

export interface FakeFileHandle {
  readonly handle: FileHandle
  readonly readCalls: FakeFileHandleCall[]
  readonly writeCalls: FakeFileHandleCall[]
  bytes (): Uint8Array
  closed (): boolean
}

export function createFakeFileHandle (initial: Uint8Array = new Uint8Array(0)): FakeFileHandle {
  let bytes = initial
  let didClose = false
  const readCalls: FakeFileHandleCall[] = []
  const writeCalls: FakeFileHandleCall[] = []

  const handle: FileHandle = {
    id: 'fake-file-handle',
    closed: new Promise(() => {}),
    close: async () => { didClose = true },
    read: async ({ position, length }) => {
      readCalls.push({ position, length })
      const end = Math.min(position + length, bytes.length)
      return end > position ? bytes.slice(position, end) : new Uint8Array(0)
    },
    write: async ({ position, data }) => {
      writeCalls.push({ position, length: data.length })
      const needed = position + data.length
      if (needed > bytes.length) {
        const grown = new Uint8Array(needed)
        grown.set(bytes)
        bytes = grown
      }
      bytes.set(data, position)
      return data.length
    },
    readable: () => { throw new Error('not used in this test') },
    writable: () => { throw new Error('not used in this test') },
    stat: async (): Promise<FileStat> => ({ size: bytes.length, isFile: true, isDirectory: false, mtimeMs: 0 }),
    truncate: async (length: number) => { bytes = bytes.slice(0, length) },
    sync: async () => {}
  }

  return {
    handle,
    readCalls,
    writeCalls,
    bytes: () => bytes,
    closed: () => didClose
  }
}
