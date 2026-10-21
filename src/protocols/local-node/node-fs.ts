// A local node's files, as the WASI host's WasiFs: node:fs confined to one
// directory. A path arrives relative to it ('.' is the directory itself); one
// that climbs out by `..`, or reaches out through a symlink, is refused.

import { lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import type { FileHandle as NodeFileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import type { FileHandle, FileStat } from '../../contracts/index.js'
import type { WasiFs } from '../../shim/wasi/context.js'
import type { OrivonErrorCode } from '../../contracts/index.js'
import { fail } from '../../broker/errors.js'

export const MAX_OPEN_FILES = 64
/** A read is served in pieces of at most this size, so a huge `length` allocates no more. */
const MAX_READ_BYTES = 8 * 1024 * 1024
const OPEN_FLAGS: ReadonlySet<string> = new Set(['r', 'r+', 'w', 'w+', 'wx', 'wx+', 'a', 'a+'])

const CODE_OF_ERRNO: Readonly<Record<string, OrivonErrorCode>> = {
  ENOENT: 'notFound', EEXIST: 'exists', EACCES: 'denied', EPERM: 'denied', EMFILE: 'limit', ENFILE: 'limit', EINVAL: 'invalid'
}

/** Names Windows reserves for devices, with any extension and in any case. Refused on every system, so the policy is the same everywhere. */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

function refusal (path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${path} is outside the node's directory`), { code: 'EACCES' })
}

/** What the WASI host reads a failure by: the OrivonError code, with the errno kept as the platform code. */
function orivonError (error: unknown): unknown {
  const errno = (error as { code?: unknown } | null)?.code
  if (typeof errno !== 'string' || !errno.startsWith('E')) return error
  return fail(CODE_OF_ERRNO[errno] ?? 'internal', error instanceof Error ? error.message : errno, undefined, errno)
}

async function translated<T> (work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw orivonError(error)
  }
}

function within (root: string, target: string): boolean {
  const way = relative(root, target)
  return way === '' || (way !== '..' && !way.startsWith(`..${sep}`) && !isAbsolute(way))
}

function statOf (real: { size: number, mtimeMs: number, isFile: () => boolean, isDirectory: () => boolean }): FileStat {
  return { size: real.size, isFile: real.isFile(), isDirectory: real.isDirectory(), mtimeMs: real.mtimeMs }
}

function fileHandle (real: NodeFileHandle, name: string, release: () => void): FileHandle {
  let done: () => void = () => {}
  const closed = new Promise<void>((resolve) => { done = resolve })
  let shut = false
  return {
    id: `local-node-file-${randomUUID()}`,
    name,
    closed,
    close: async () => {
      if (shut) return
      shut = true
      release()
      await real.close()
      done()
    },
    read: async ({ position, length }) => await translated(async () => {
      const wanted = Math.min(length, MAX_READ_BYTES)
      const buffer = Buffer.alloc(wanted)
      const { bytesRead } = await real.read({ buffer, position, length: wanted })
      return new Uint8Array(buffer.subarray(0, bytesRead))
    }),
    write: async ({ position, data }) => await translated(async () => (await real.write(data, 0, data.length, position)).bytesWritten),
    readable: () => { throw Object.assign(new Error('streams are not served'), { code: 'ENOSYS' }) },
    writable: () => { throw Object.assign(new Error('streams are not served'), { code: 'ENOSYS' }) },
    stat: async () => await translated(async () => statOf(await real.stat())),
    truncate: async (length) => { await translated(async () => { await real.truncate(length) }) },
    sync: async () => { await translated(async () => { await real.sync() }) }
  }
}

/** Makes the directory (if absent) and returns the WasiFs over it. */
export async function createConfinedFs (directory: string): Promise<WasiFs> {
  await mkdir(directory, { recursive: true })
  const root = await realpath(directory)
  let openFiles = 0

  /** The real path of `path` under the root: the path itself if it exists, else its deepest existing ancestor's real path plus the rest. */
  async function confine (path: string): Promise<string> {
    if (typeof path !== 'string' || path.includes('\0') || isAbsolute(path)) throw refusal(String(path))
    const clean = normalize(path)
    if (clean === '..' || clean.startsWith(`..${sep}`)) throw refusal(path)
    if (clean.split(/[\\/]/).some((segment) => DEVICE_NAME.test(segment))) throw refusal(path)
    const wanted = join(root, clean)
    let existing = wanted
    const missing: string[] = []
    for (;;) {
      try {
        const real = await realpath(existing)
        if (!within(root, real)) throw refusal(path)
        return join(real, ...missing)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (existing === root) throw error
        // A name that exists but does not resolve is a dangling symlink: opening it for writing would create what it points at.
        if (await lstat(existing).then(() => true, () => false)) throw refusal(path)
        missing.unshift(existing.slice(dirname(existing).length + 1))
        existing = dirname(existing)
      }
    }
  }

  return {
    open: async (path, flags) => await translated(async () => {
      if (!OPEN_FLAGS.has(flags)) throw Object.assign(new Error('unsupported open flags'), { code: 'EINVAL' })
      const real = await confine(path)
      if (openFiles >= MAX_OPEN_FILES) throw Object.assign(new Error('too many open files'), { code: 'EMFILE' })
      openFiles += 1
      try {
        return fileHandle(await open(real, flags, 0o600), basename(real), () => { openFiles -= 1 })
      } catch (error) {
        openFiles -= 1
        throw error
      }
    }),
    stat: async (path) => await translated(async () => statOf(await stat(await confine(path)))),
    readdir: async (path) => await translated(async () => await readdir(await confine(path))),
    mkdir: async (path, options) => { await translated(async () => { await mkdir(await confine(path), { recursive: options?.recursive === true, mode: 0o700 }) }) },
    rm: async (path, options) => {
      await translated(async () => {
        const real = await confine(path)
        if (real === root) throw refusal(path)
        await rm(real, { recursive: options?.recursive === true })
      })
    },
    rename: async (from, to) => {
      await translated(async () => {
        const source = await confine(from)
        const target = await confine(to)
        if (source === root || target === root) throw refusal(from)
        await rename(source, target)
      })
    }
  }
}
