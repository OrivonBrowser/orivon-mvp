// Exercises node-fs-handle.ts's own local cursor and callback family --
// node-fs.test.ts only proves node-fs.ts's re-export routes here. Same
// stubbed-globalThis.orivon pattern as node-fs.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Orivon } from '../../contracts/capability-api.js'
import { createFakeFileHandle, type FakeFileHandle } from './support/fake-file-handle.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }

function installFakeOrivon (initial?: Uint8Array): FakeFileHandle {
  const fake = createFakeFileHandle(initial)
  ;(globalThis as GlobalWithOrivon).orivon = {
    fs: { open: async () => fake.handle }
  } as unknown as Orivon
  return fake
}

afterEach(() => {
  delete (globalThis as GlobalWithOrivon).orivon
  vi.resetModules()
})

describe('fs.promises.open -- the local cursor', () => {
  it('every positional call sends an EXPLICIT position underneath -- the contract has no cursor of its own', async () => {
    const fake = installFakeOrivon()
    const { openHandle } = await import('../node-fs-handle.js')
    const handle = await openHandle('/piece-0', 'w+')
    await handle.write(new Uint8Array([1, 2, 3]), 0, 3, 0)
    expect(fake.writeCalls).toEqual([{ position: 0, length: 3 }])
  })

  it('a null position write lands at 0 on a fresh handle, then a second null-position write continues from where the first left off', async () => {
    const fake = installFakeOrivon()
    const { openHandle } = await import('../node-fs-handle.js')
    const handle = await openHandle('/piece-0', 'w+')
    await handle.write(new Uint8Array([1, 2, 3]))
    await handle.write(new Uint8Array([4, 5]))
    expect(fake.writeCalls).toEqual([{ position: 0, length: 3 }, { position: 3, length: 2 }])
    expect([...fake.bytes()]).toEqual([1, 2, 3, 4, 5])
  })

  it('interleaved null-position reads and writes on the SAME handle advance one shared cursor correctly', async () => {
    const fake = installFakeOrivon(new Uint8Array([9, 9, 9, 9, 9, 9]))
    const { openHandle } = await import('../node-fs-handle.js')
    const handle = await openHandle('/piece-0', 'r+')

    const first = await handle.read(new Uint8Array(2)) // reads [0,2) -> cursor now 2
    const write = await handle.write(new Uint8Array([7, 7])) // writes at 2 -> cursor now 4
    const second = await handle.read(new Uint8Array(2)) // reads [4,6) -> cursor now 6

    expect(first.bytesRead).toBe(2)
    expect(write.bytesWritten).toBe(2)
    expect(second.bytesRead).toBe(2)
    expect(fake.readCalls).toEqual([{ position: 0, length: 2 }, { position: 4, length: 2 }])
    expect(fake.writeCalls).toEqual([{ position: 2, length: 2 }])
  })

  it('an explicit-position call does NOT touch the shared cursor -- a later null-position call is unaffected by it', async () => {
    const fake = installFakeOrivon()
    const { openHandle } = await import('../node-fs-handle.js')
    const handle = await openHandle('/piece-0', 'w+')
    await handle.write(new Uint8Array([1, 2])) // cursor now 2
    await handle.write(new Uint8Array([99]), 0, 1, 100) // explicit position 100 -- cursor untouched
    await handle.write(new Uint8Array([3])) // should still land at 2, not 101
    expect(fake.writeCalls).toEqual([
      { position: 0, length: 2 },
      { position: 100, length: 1 },
      { position: 2, length: 1 }
    ])
  })

  it('a short read at EOF advances the cursor by the ACTUAL bytes read, not the requested length', async () => {
    const fake = installFakeOrivon(new Uint8Array([1, 2, 3]))
    const { openHandle } = await import('../node-fs-handle.js')
    const handle = await openHandle('/piece-0', 'r')
    const short = await handle.read(new Uint8Array(10)) // only 3 bytes exist
    expect(short.bytesRead).toBe(3)
    const next = await handle.read(new Uint8Array(10))
    expect(next.bytesRead).toBe(0)
    expect(fake.readCalls).toEqual([{ position: 0, length: 10 }, { position: 3, length: 10 }])
  })

  it('append-mode flags seed the cursor at the file\'s current size, not 0', async () => {
    const fake = installFakeOrivon(new Uint8Array([1, 2, 3, 4]))
    const { openHandle } = await import('../node-fs-handle.js')
    const handle = await openHandle('/piece-0', 'a')
    await handle.write(new Uint8Array([9]))
    expect(fake.writeCalls).toEqual([{ position: 4, length: 1 }])
  })

  it('a -1 position is treated as "use the cursor", matching real Node\'s own read() contract', async () => {
    const fake = installFakeOrivon(new Uint8Array([1, 2, 3]))
    const { openHandle } = await import('../node-fs-handle.js')
    const handle = await openHandle('/piece-0', 'r')
    await handle.read(new Uint8Array(1), 0, 1, -1)
    expect(fake.readCalls).toEqual([{ position: 0, length: 1 }])
  })

  // Real Node's FileHandle#datasync -- orivon.fs has one durability
  // primitive (sync()), not two, so this is that same call under a second
  // name (node-fs-handle.ts's own comment on datasync()).
  it('datasync() succeeds on an ordinary file handle, the same as sync()', async () => {
    installFakeOrivon()
    const { openHandle } = await import('../node-fs-handle.js')
    const handle = await openHandle('/piece-0', 'r+')
    await expect(handle.datasync()).resolves.toBeUndefined()
  })
})

describe('fs.promises.open -- FileHandle stream gap (A184)', () => {
  it('createReadStream refuses loudly, citing A184, rather than returning a stream that can never move a byte', async () => {
    installFakeOrivon()
    const { openHandle } = await import('../node-fs-handle.js')
    const handle = await openHandle('/piece-0', 'r')
    const { OrivonShimError } = await import('../errors.js')
    expect(() => handle.createReadStream()).toThrow(OrivonShimError)
    try {
      handle.createReadStream()
    } catch (error) {
      expect((error as InstanceType<typeof OrivonShimError>).reason).toBe('not-built')
      expect((error as InstanceType<typeof OrivonShimError>).message).toMatch(/A184/)
    }
  })

  it('createWriteStream refuses the same way', async () => {
    installFakeOrivon()
    const { openHandle } = await import('../node-fs-handle.js')
    const handle = await openHandle('/piece-0', 'w')
    const { OrivonShimError } = await import('../errors.js')
    expect(() => handle.createWriteStream()).toThrow(OrivonShimError)
  })
})

// @seald-io/nedb's own flushToStorageAsync opens a PATH WITH FLAGS 'r' TO
// FSYNC A DIRECTORY (crashSafeWriteFileLinesAsync fsyncs the datafile's
// parent dir before and after every rewrite) -- open()/sync()/close() below
// have no file-vs-directory branch of their own (node-fs-handle.ts's own
// comment on `sync()`), so whatever orivon.fs.open does with a directory
// path is exactly what a caller sees. Real Node's own fsync-a-directory
// support is itself platform-dependent (works on Linux/macOS, EISDIR on
// some others); nedb's own flushToStorageAsync already tolerates that.
describe('fs.promises.open -- opening a directory path for fsync, not a regular file', () => {
  it('open("r") + sync() + close() on a directory succeeds when the broker\'s own open does (Linux/macOS)', async () => {
    installFakeOrivon()
    const { openHandle } = await import('../node-fs-handle.js')
    const handle = await openHandle('/torrents', 'r')
    await expect(handle.sync()).resolves.toBeUndefined()
    await expect(handle.close()).resolves.toBeUndefined()
  })

  it('a platform where opening a directory fails (e.g. EISDIR on Windows) surfaces as a Node-shaped error, not a crash', async () => {
    // Shaped the way the broker's own mapIoError (io-errors.ts) would hand
    // it here: EISDIR is not in that table's errno list, so it fails closed
    // as 'internal' with the real errno preserved as platformCode --
    // toNodeError then prefers platformCode over the closed-enum code
    // (node-http-errors.ts rule 2), so this shim sees 'EISDIR', not
    // 'internal'.
    (globalThis as GlobalWithOrivon).orivon = {
      fs: { open: async () => { throw Object.assign(new Error('is a directory'), { code: 'internal', platformCode: 'EISDIR' }) } }
    } as unknown as Orivon
    const { openHandle } = await import('../node-fs-handle.js')
    await expect(openHandle('/torrents', 'r')).rejects.toMatchObject({ code: 'EISDIR' })
  })
})

describe('the callback open/read/write/close family', () => {
  it('open -> write -> read -> close round-trips bytes through synthetic fds', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs-handle.js')
    const fd = await new Promise<number>((resolve, reject) => {
      fs.open('/piece-0', 'w+', (err, result) => (err !== null ? reject(err) : resolve(result as number)))
    })
    expect(typeof fd).toBe('number')

    await new Promise<void>((resolve, reject) => {
      fs.write(fd, new Uint8Array([1, 2, 3]), 0, 3, 0, (err) => (err !== null ? reject(err) : resolve()))
    })

    const buffer = new Uint8Array(3)
    const bytesRead = await new Promise<number>((resolve, reject) => {
      fs.read(fd, buffer, 0, 3, 0, (err, n) => (err !== null ? reject(err) : resolve(n)))
    })
    expect(bytesRead).toBe(3)
    expect([...buffer]).toEqual([1, 2, 3])

    await new Promise<void>((resolve, reject) => {
      fs.close(fd, (err) => (err !== null ? reject(err) : resolve()))
    })
  })

  it('write() omitting offset/length/position defaults exactly like real Node -- whole buffer, at the cursor', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs-handle.js')
    const fd = await new Promise<number>((resolve, reject) => {
      fs.open('/piece-0', 'w+', (err, result) => (err !== null ? reject(err) : resolve(result as number)))
    })
    const bytesWritten = await new Promise<number>((resolve, reject) => {
      fs.write(fd, new Uint8Array([1, 2, 3, 4]), (err, n) => (err !== null ? reject(err) : resolve(n)))
    })
    expect(bytesWritten).toBe(4)
  })

  it('fstat/ftruncate/fsync route through the open handle', async () => {
    installFakeOrivon(new Uint8Array([1, 2, 3]))
    const fs = await import('../node-fs-handle.js')
    const fd = await new Promise<number>((resolve, reject) => {
      fs.open('/piece-0', 'r+', (err, result) => (err !== null ? reject(err) : resolve(result as number)))
    })

    const stat = await new Promise<import('../node-fs-stats.js').NodeStats>((resolve, reject) => {
      fs.fstat(fd, (err, result) => (err !== null ? reject(err) : resolve(result as import('../node-fs-stats.js').NodeStats)))
    })
    expect(stat.size).toBe(3)

    await new Promise<void>((resolve, reject) => {
      fs.ftruncate(fd, 1, (err) => (err !== null ? reject(err) : resolve()))
    })
    await new Promise<void>((resolve, reject) => {
      fs.fsync(fd, (err) => (err !== null ? reject(err) : resolve()))
    })
  })

  // test-the-guards-failure-path: an fd that was never opened, or already
  // closed, is a real, ordinary Node runtime condition (EBADF) -- every
  // callback below must report it, never throw synchronously or hang.
  describe('an invalid fd is a Node-shaped EBADF error, not a thrown exception or a silent hang', () => {
    it('close on an unknown fd', async () => {
      installFakeOrivon()
      const fs = await import('../node-fs-handle.js')
      const error = await new Promise<Error & { code?: string }>((resolve) => {
        fs.close(999, (err) => resolve(err as Error & { code?: string }))
      })
      expect(error.code).toBe('EBADF')
    })

    it('read/write/fstat/ftruncate/fsync all reject the same way on an unknown fd', async () => {
      installFakeOrivon()
      const fs = await import('../node-fs-handle.js')
      const buffer = new Uint8Array(1)

      const readError = await new Promise<Error & { code?: string }>((resolve) => {
        fs.read(999, buffer, 0, 1, 0, (err) => resolve(err as Error & { code?: string }))
      })
      const writeError = await new Promise<Error & { code?: string }>((resolve) => {
        fs.write(999, buffer, (err) => resolve(err as Error & { code?: string }))
      })
      const statError = await new Promise<Error & { code?: string }>((resolve) => {
        fs.fstat(999, (err) => resolve(err as Error & { code?: string }))
      })
      const truncateError = await new Promise<Error & { code?: string }>((resolve) => {
        fs.ftruncate(999, (err) => resolve(err as Error & { code?: string }))
      })
      const syncError = await new Promise<Error & { code?: string }>((resolve) => {
        fs.fsync(999, (err) => resolve(err as Error & { code?: string }))
      })

      for (const error of [readError, writeError, statError, truncateError, syncError]) {
        expect(error.code).toBe('EBADF')
      }
    })

    it('close() frees the fd -- a second operation on it afterward is also EBADF, not a stale-handle success', async () => {
      installFakeOrivon()
      const fs = await import('../node-fs-handle.js')
      const fd = await new Promise<number>((resolve, reject) => {
        fs.open('/piece-0', 'r+', (err, result) => (err !== null ? reject(err) : resolve(result as number)))
      })
      await new Promise<void>((resolve, reject) => {
        fs.close(fd, (err) => (err !== null ? reject(err) : resolve()))
      })
      const error = await new Promise<Error & { code?: string }>((resolve) => {
        fs.fstat(fd, (err) => resolve(err as Error & { code?: string }))
      })
      expect(error.code).toBe('EBADF')
    })
  })

  it('fs.open(path, callback) -- the flags-defaults-to-\'r\' form -- refuses loudly instead of silently misreading the callback as flags', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs-handle.js')
    expect(() => (fs.open as (path: string, callback: unknown) => void)('/piece-0', () => {})).toThrow(TypeError)
  })
})
