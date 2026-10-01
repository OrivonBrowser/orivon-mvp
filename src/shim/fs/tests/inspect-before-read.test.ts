// A dependency that checks a file with lstat, opens it with numeric O_* flags
// and writes it through a FileHandle (the shape of an atomic checkpoint
// store) must run on this shim as it does on Node: these are the members
// that shape needs.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Orivon } from '../../../contracts/capability-api.js'
import type { FileStat } from '../../../contracts/handles.js'
import { createFakeFileHandle } from '../../tests/support/fake-file-handle.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }

function installFakeOrivon (): {
  files: Map<string, Uint8Array>
  stats: Map<string, FileStat>
  openCalls: Array<{ path: string, flags: string }>
} {
  const files = new Map<string, Uint8Array>()
  const stats = new Map<string, FileStat>()
  const openCalls: Array<{ path: string, flags: string }> = []
  ;(globalThis as GlobalWithOrivon).orivon = {
    fs: {
      stat: async (path: string) => {
        const stat = stats.get(path)
        if (stat === undefined) throw Object.assign(new Error('no such file'), { code: 'notFound' })
        return stat
      },
      open: async (path: string, flags: string) => {
        openCalls.push({ path, flags })
        const fake = createFakeFileHandle(files.get(path) ?? new Uint8Array(0))
        const write = fake.handle.write.bind(fake.handle)
        fake.handle.write = async (opts) => { const n = await write(opts); files.set(path, fake.bytes()); return n }
        return fake.handle
      }
    }
  } as unknown as Orivon
  return { files, stats, openCalls }
}

afterEach(() => {
  delete (globalThis as GlobalWithOrivon).orivon
  vi.resetModules()
})

describe('fs.promises.lstat and fs.lstat', () => {
  it('answers like stat for an existing path, and never reports a symlink', async () => {
    const { stats } = installFakeOrivon()
    stats.set('a', { size: 4, isFile: true, isDirectory: false, mtimeMs: 5 })
    const { promises } = await import('../promises.js')
    const result = await promises.lstat('a')
    expect(result.isFile()).toBe(true)
    expect(result.isSymbolicLink()).toBe(false)
    expect(result.size).toBe(4)
  })

  it('rejects a missing path the way stat does', async () => {
    installFakeOrivon()
    const { promises } = await import('../promises.js')
    await expect(promises.lstat('missing')).rejects.toMatchObject({ code: 'notFound' })
  })

  it('is a named export of fs/promises and a callback member of fs', async () => {
    const { stats } = installFakeOrivon()
    stats.set('a', { size: 1, isFile: true, isDirectory: false, mtimeMs: 0 })
    const promisesModule = await import('../promises.js')
    expect(typeof promisesModule.lstat).toBe('function')
    const fs = await import('../fs.js')
    const result = await new Promise((resolve, reject) => {
      fs.lstat('a', (error, value) => (error === null ? resolve(value) : reject(error)))
    })
    expect((result as { size: number }).size).toBe(1)
  })
})

describe('fs.constants open flags', () => {
  it('carries the Linux values Node reports', async () => {
    const { FS_CONSTANTS } = await import('../constants.js')
    expect(FS_CONSTANTS).toMatchObject({
      O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128,
      O_TRUNC: 512, O_APPEND: 1024, O_NONBLOCK: 2048, O_NOFOLLOW: 131072
    })
  })
})

describe('numeric open flags', () => {
  it('opens read-only with O_RDONLY | O_NOFOLLOW | O_NONBLOCK as "r"', async () => {
    const { stats, openCalls } = installFakeOrivon()
    stats.set('a', { size: 0, isFile: true, isDirectory: false, mtimeMs: 0 })
    const { promises, constants } = await import('../promises.js')
    const handle = await promises.open('a', constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    await handle.close()
    expect(openCalls).toEqual([{ path: 'a', flags: 'r' }])
  })

  it('maps a create-exclusive write to "wx" and refuses a combination no string flag expresses', async () => {
    const { openCalls } = installFakeOrivon()
    const { promises, constants } = await import('../promises.js')
    await (await promises.open('b', constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)).close()
    expect(openCalls).toEqual([{ path: 'b', flags: 'wx' }])
    await expect(promises.open('c', constants.O_RDONLY | constants.O_TRUNC)).rejects.toMatchObject({ code: 'EINVAL' })
  })

  it('accepts a number in the callback open and in openSync', async () => {
    const { openCalls } = installFakeOrivon()
    const fs = await import('../fs.js')
    const fd = await new Promise<number>((resolve, reject) => {
      fs.open('d', 0, (error, value) => (error === null ? resolve(value as number) : reject(error)))
    })
    expect(typeof fd).toBe('number')
    expect(openCalls).toEqual([{ path: 'd', flags: 'r' }])
  })
})

describe('FileHandle#writeFile', () => {
  it('writes bytes from the current position, as Node does', async () => {
    const { files } = installFakeOrivon()
    const { promises } = await import('../promises.js')
    const handle = await promises.open('w', 'wx')
    await handle.writeFile(new Uint8Array([1, 2, 3]))
    await handle.writeFile(new Uint8Array([4]))
    await handle.close()
    expect(files.get('w')).toEqual(new Uint8Array([1, 2, 3, 4]))
  })

  it('encodes a string with the given encoding, utf8 by default', async () => {
    const { files } = installFakeOrivon()
    const { promises } = await import('../promises.js')
    const handle = await promises.open('s', 'wx')
    await handle.writeFile('héllo')
    await handle.close()
    expect(new TextDecoder().decode(files.get('s'))).toBe('héllo')
  })
})
