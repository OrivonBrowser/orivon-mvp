// Exercises node-fs-root.ts's own root-path detection and fake handle, plus
// how node-fs-handle.ts's fs.open/fs.promises.open and node-fs-core.ts's
// mkdir route a root-resolving path -- never through orivon.fs, which the
// broker's own confinement policy (src/broker/policy/paths.ts's 'is-root')
// refuses unconditionally for exactly this input. `installRootRefusingOrivon`
// below fails loudly if the shim ever forwards a root path to it, the same
// way a real fake-confinement double would -- proving the interception
// happens IN THE SHIM, not by luck.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Orivon } from '../../contracts/capability-api.js'
import { isRootPath } from '../node-fs-root.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }

function deniedIsRoot (): Error {
  return Object.assign(new Error("the path is outside this app's files directory"), {
    name: 'OrivonError',
    code: 'denied'
  })
}

/** A fake orivon.fs that throws the broker's own 'is-root' denial shape for any root-resolving path, and otherwise behaves like an ordinary in-memory fake -- so a test can prove the shim never even reaches it for '.'. */
function installRootRefusingOrivon (): { openCalls: Array<{ path: string, flags: string }>, mkdirCalls: Array<{ path: string, opts: unknown }> } {
  const openCalls: Array<{ path: string, flags: string }> = []
  const mkdirCalls: Array<{ path: string, opts: unknown }> = []
  ;(globalThis as GlobalWithOrivon).orivon = {
    fs: {
      open: async (path: string, flags: string) => {
        if (isRootPath(path)) throw deniedIsRoot()
        openCalls.push({ path, flags })
        throw new Error('not used in this test')
      },
      mkdir: async (path: string, opts: unknown) => {
        if (isRootPath(path)) throw deniedIsRoot()
        mkdirCalls.push({ path, opts })
      },
      stat: async (path: string) => {
        if (isRootPath(path)) throw deniedIsRoot()
        throw new Error('not used in this test')
      }
    }
  } as unknown as Orivon
  return { openCalls, mkdirCalls }
}

afterEach(() => {
  delete (globalThis as GlobalWithOrivon).orivon
  vi.resetModules()
})

describe('isRootPath', () => {
  it.each(['.', './', 'a/..', './a/..', 'a/b/../..'])('%s is a root-resolving path', (path) => {
    expect(isRootPath(path)).toBe(true)
  })

  it.each(['settings.db', './settings.db', 'a/b', '..', '../x', 'torrents/piece-0'])(
    '%s is not',
    (path) => {
      expect(isRootPath(path)).toBe(false)
    }
  )
})

describe('fs.promises.mkdir(root, ...) -- never reaches orivon.fs', () => {
  it('recursive:true succeeds locally, without calling orivon.fs.mkdir', async () => {
    const { mkdirCalls } = installRootRefusingOrivon()
    const { promises } = await import('../node-fs-promises.js')
    await expect(promises.mkdir('.', { recursive: true })).resolves.toBeUndefined()
    expect(mkdirCalls).toEqual([])
  })

  it('no recursive option fails EEXIST, matching Node for an existing directory', async () => {
    installRootRefusingOrivon()
    const { promises } = await import('../node-fs-promises.js')
    await expect(promises.mkdir('.')).rejects.toMatchObject({ code: 'EEXIST' })
  })

  it('recursive:false fails EEXIST too', async () => {
    installRootRefusingOrivon()
    const { promises } = await import('../node-fs-promises.js')
    await expect(promises.mkdir('.', { recursive: false })).rejects.toMatchObject({ code: 'EEXIST' })
  })

  it('the callback family shares the same core', async () => {
    const { mkdirCalls } = installRootRefusingOrivon()
    const fs = await import('../node-fs.js')
    await new Promise<void>((resolve, reject) => {
      fs.mkdir('.', { recursive: true }, (err) => (err !== null ? reject(err) : resolve()))
    })
    expect(mkdirCalls).toEqual([])
    const error = await new Promise<Error & { code?: string }>((resolve) => {
      fs.mkdir('.', (err) => resolve(err as Error & { code?: string }))
    })
    expect(error.code).toBe('EEXIST')
  })
})

describe('fs.promises.open(root, ...) -- a local directory handle, never orivon.fs.open', () => {
  it("opens with flags 'r' and returns a working fd, without calling orivon.fs.open", async () => {
    const { openCalls } = installRootRefusingOrivon()
    const { promises } = await import('../node-fs-promises.js')
    const handle = await promises.open('.', 'r')
    expect(typeof handle.fd).toBe('number')
    expect(openCalls).toEqual([])
  })

  it.each(['w', 'a', 'r+', 'w+', 'a+'])('any other flag (%s) fails EISDIR immediately', async (flags) => {
    installRootRefusingOrivon()
    const { promises } = await import('../node-fs-promises.js')
    await expect(promises.open('.', flags)).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it("sync()/datasync()/close() succeed", async () => {
    installRootRefusingOrivon()
    const { promises } = await import('../node-fs-promises.js')
    const handle = await promises.open('.', 'r')
    await expect(handle.sync()).resolves.toBeUndefined()
    await expect(handle.datasync()).resolves.toBeUndefined()
    await expect(handle.close()).resolves.toBeUndefined()
  })

  it('read fails EISDIR -- checked against real Node on Linux, not assumed', async () => {
    installRootRefusingOrivon()
    const { promises } = await import('../node-fs-promises.js')
    const handle = await promises.open('.', 'r')
    await expect(handle.read(new Uint8Array(4))).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('write fails EBADF -- the fd itself is read-only, checked against real Node, not EISDIR as might be assumed', async () => {
    installRootRefusingOrivon()
    const { promises } = await import('../node-fs-promises.js')
    const handle = await promises.open('.', 'r')
    await expect(handle.write(new Uint8Array([1]))).rejects.toMatchObject({ code: 'EBADF' })
  })

  it('truncate fails EINVAL -- checked against real Node, not EISDIR as might be assumed', async () => {
    installRootRefusingOrivon()
    const { promises } = await import('../node-fs-promises.js')
    const handle = await promises.open('.', 'r')
    await expect(handle.truncate(0)).rejects.toMatchObject({ code: 'EINVAL' })
  })

  it('stat SUCCEEDS on a directory fd -- checked against real Node, corrects the naive "everything is EISDIR" assumption', async () => {
    installRootRefusingOrivon()
    const { promises } = await import('../node-fs-promises.js')
    const handle = await promises.open('.', 'r')
    const stat = await handle.stat()
    expect(stat.isDirectory()).toBe(true)
    expect(stat.isFile()).toBe(false)
  })

  it('the callback fs.open + fs.fsync + fs.close path works the same way', async () => {
    const { openCalls } = installRootRefusingOrivon()
    const fs = await import('../node-fs.js')
    const fd = await new Promise<number>((resolve, reject) => {
      fs.open('.', 'r', (err, result) => (err !== null ? reject(err) : resolve(result as number)))
    })
    expect(typeof fd).toBe('number')
    expect(openCalls).toEqual([])
    await new Promise<void>((resolve, reject) => {
      fs.fsync(fd, (err) => (err !== null ? reject(err) : resolve()))
    })
    await new Promise<void>((resolve, reject) => {
      fs.close(fd, (err) => (err !== null ? reject(err) : resolve()))
    })
  })
})

describe('stat(\'.\')/readdir(\'.\') -- answered locally, never the broker\'s refusal', () => {
  it('stat is a directory', async () => {
    installRootRefusingOrivon()
    const { promises } = await import('../node-fs-promises.js')
    const stat = await promises.stat('.')
    expect(stat.isDirectory()).toBe(true)
  })

  it('readdir fails EACCES, naming what the broker cannot list', async () => {
    (globalThis as GlobalWithOrivon).orivon = {
      fs: { readdir: async (path: string) => { if (isRootPath(path)) throw deniedIsRoot(); return [] } }
    } as unknown as Orivon
    const { promises } = await import('../node-fs-promises.js')
    await expect(promises.readdir('.')).rejects.toMatchObject({ code: 'EACCES', syscall: 'scandir' })
  })

  it('readFile is EISDIR, as Node gives for a directory', async () => {
    installRootRefusingOrivon()
    const { promises } = await import('../node-fs-promises.js')
    await expect(promises.readFile('.')).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('rm, unlink and rename of the root fail EACCES', async () => {
    installRootRefusingOrivon()
    const { promises } = await import('../node-fs-promises.js')
    await expect(promises.rm('.', { recursive: true })).rejects.toMatchObject({ code: 'EACCES', syscall: 'rm' })
    await expect(promises.unlink('.')).rejects.toMatchObject({ code: 'EACCES', syscall: 'unlink' })
    await expect(promises.rename('.', 'x')).rejects.toMatchObject({ code: 'EACCES', syscall: 'rename' })
  })
})
