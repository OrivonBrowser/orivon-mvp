// A fake `orivon.fs` (src/contracts/capability-api.ts) backed by a REAL
// temporary directory on disk, via real node:fs/promises -- not the
// in-memory Map every other fs test here uses. nedb-storage.test.ts needs
// this: proving the shim's fs surface round-trips through @seald-io/nedb's
// own storage layer means proving real bytes land in a real file, not that
// an in-memory stand-in agrees with itself.
//
// EVERY PATH IS JOINED AGAINST `root`, NEVER TRUSTED AS ABSOLUTE -- the same
// shape the real broker's own confineForOrigin gives (fs-capability.ts,
// src/broker/, not imported here: this file is test-only and stays on the
// shim side of that boundary), so a relative path like nedb's own
// 'settings.db' lands inside `root` exactly like it would against a real
// per-origin files directory.
//
// ERRORS ARE RE-SHAPED TO MATCH THE BROKER'S OWN mapIoError (io-errors.ts) --
// re-derived here, not imported (same boundary reason) -- so a caller
// branching on `.code`/`.platformCode` sees what a real broker would hand
// back, not a raw Node errno the shim's toNodeError would then fail to
// recognise as an OrivonError at all.

import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import type { Orivon } from '../../../contracts/capability-api.js'
import type { FileHandle, FileStat } from '../../../contracts/handles.js'

/** Mirrors io-errors.ts's ERRNO_TO_CODE -- see this file's own header for why it is re-derived, not imported. */
const ERRNO_TO_CODE: Readonly<Record<string, string>> = {
  ENOENT: 'notFound',
  EEXIST: 'exists',
  EACCES: 'denied',
  EPERM: 'denied'
}

function mapError (error: unknown): never {
  const errno = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  const code = typeof errno === 'string' ? (ERRNO_TO_CODE[errno] ?? 'internal') : 'internal'
  const message = error instanceof Error ? error.message : String(error)
  throw Object.assign(new Error(message), { name: 'OrivonError', code, platformCode: errno })
}

function toFileStat (real: { size: number, mtimeMs: number, isFile: () => boolean, isDirectory: () => boolean }): FileStat {
  return { size: real.size, isFile: real.isFile(), isDirectory: real.isDirectory(), mtimeMs: real.mtimeMs }
}

function wrapHandle (real: Awaited<ReturnType<typeof open>>): FileHandle {
  return {
    id: `real-disk-fs-handle-${real.fd}`,
    closed: new Promise(() => {}),
    close: async () => { await real.close() },
    read: async ({ position, length }) => {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await real.read({ buffer, position, length })
      return new Uint8Array(buffer.subarray(0, bytesRead))
    },
    write: async ({ position, data }) => {
      const { bytesWritten } = await real.write(data, 0, data.length, position)
      return bytesWritten
    },
    readable: () => { throw new Error('not used by nedb-storage.test.ts -- fs.createReadStream uses node-fs-handle.ts\'s own open/read, not this') },
    writable: () => { throw new Error('not used by nedb-storage.test.ts -- fs.createWriteStream uses node-fs-handle.ts\'s own open/write, not this') },
    stat: async () => toFileStat(await real.stat()),
    truncate: async (length) => { await real.truncate(length) },
    // A real fsync -- @seald-io/nedb's own flushToStorageAsync (open + sync
    // + close, on both the datafile and its parent directory) is exactly
    // what this proves works end to end on this platform.
    sync: async () => { await real.sync() }
  }
}

export interface RealDiskFs {
  readonly orivon: Orivon
  readonly root: string
  /** Reads a file directly off the real filesystem, bypassing the shim entirely -- for asserting the actual on-disk bytes. */
  readRealFile: (relativePath: string) => Promise<string>
  /** True when a real file (or directory) sits at `root`/relativePath -- bypassing the shim entirely, same reason as readRealFile. */
  existsOnDisk: (relativePath: string) => Promise<boolean>
  cleanup: () => Promise<void>
}

/** One per test -- a fresh OS temp directory, deleted in `cleanup()`. */
export async function createRealDiskFs (): Promise<RealDiskFs> {
  const root = await mkdtemp(join(tmpdir(), 'orivon-shim-nedb-'))
  const resolve = (path: string): string => join(root, path)

  const fs: Orivon['fs'] = {
    readFile: async (path) => { try { return new Uint8Array(await readFile(resolve(path))) } catch (error) { mapError(error) } },
    writeFile: async (path, data) => { try { await writeFile(resolve(path), data) } catch (error) { mapError(error) } },
    readFileSync: () => { throw new Error('not used by nedb-storage.test.ts') },
    open: async (path, flags) => { try { return wrapHandle(await open(resolve(path), flags)) } catch (error) { mapError(error) } },
    mkdir: async (path, opts) => { try { await mkdir(resolve(path), { recursive: opts?.recursive }) } catch (error) { mapError(error) } },
    readdir: async (path) => { try { return await readdir(resolve(path)) } catch (error) { mapError(error) } },
    stat: async (path) => { try { return toFileStat(await stat(resolve(path))) } catch (error) { mapError(error) } },
    rm: async (path, opts) => { try { await rm(resolve(path), { recursive: opts?.recursive ?? false }) } catch (error) { mapError(error) } },
    rename: async (from, to) => { try { await rename(resolve(from), resolve(to)) } catch (error) { mapError(error) } },
    userSelected: (async () => { throw new Error('not used by nedb-storage.test.ts') }) as Orivon['fs']['userSelected']
  }

  return {
    orivon: { version: 0, fs, app: undefined, net: undefined, id: undefined } as unknown as Orivon,
    root,
    readRealFile: async (relativePath) => await readFile(join(root, relativePath), 'utf8'),
    existsOnDisk: async (relativePath) => {
      try {
        await stat(join(root, relativePath))
        return true
      } catch {
        return false
      }
    },
    cleanup: async () => { await rm(root, { recursive: true, force: true }) }
  }
}

/** True when `path` never escaped `root` -- proves a relative path like nedb's own 'settings.db' landed inside the app's own fs root, never anywhere else. */
export function isInside (root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep)
}
