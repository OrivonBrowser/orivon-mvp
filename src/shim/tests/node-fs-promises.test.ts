// Exercises fs.promises (node-fs-promises.ts) directly -- node-fs.test.ts
// already proves node-fs.ts's callback family shares the SAME core
// (node-fs-core.ts), so this file's job is proving the promise surface
// itself resolves/rejects correctly, not re-testing encoding or error
// mapping a second time.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Orivon } from '../../contracts/capability-api.js'
import type { FileStat } from '../../contracts/handles.js'
import { createFakeFileHandle } from './support/fake-file-handle.js'
import { PageBuffer } from './support/page-buffer.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }

function orivonError (code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

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
      readFile: async (path: string) => {
        const data = files.get(path)
        if (data === undefined) throw orivonError('notFound', 'no such file')
        return data
      },
      writeFile: async (path: string, data: Uint8Array) => { files.set(path, data) },
      mkdir: async () => {},
      readdir: async (path: string) => (path === '/torrents' ? ['a.bin', 'b.bin'] : []),
      stat: async (path: string) => {
        const stat = stats.get(path)
        if (stat === undefined) throw orivonError('notFound', 'no such file')
        return stat
      },
      rm: async () => {},
      rename: async () => {},
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

describe('fs.promises', () => {
  it('writeFile then readFile round-trips bytes as a real Buffer', async () => {
    const { files } = installFakeOrivon()
    const { promises } = await import('../node-fs-promises.js')
    await promises.writeFile('/x', new Uint8Array([1, 2, 3]))
    expect(files.get('/x')).toEqual(new Uint8Array([1, 2, 3]))
    const data = await promises.readFile('/x')
    expect(PageBuffer.isBuffer(data)).toBe(true)
  })

  it('readFile respects an encoding option', async () => {
    installFakeOrivon()
    const { promises } = await import('../node-fs-promises.js')
    await promises.writeFile('/x', '{"ok":true}')
    expect(await promises.readFile('/x', 'utf8')).toBe('{"ok":true}')
  })

  it('appendFile opens with flags \'a\' -- a real append, sharing node-fs-core.ts\'s doAppendFile with the callback surface', async () => {
    const { files, openCalls } = installFakeOrivon()
    files.set('/log', new TextEncoder().encode('first\n'))
    const { promises } = await import('../node-fs-promises.js')
    await promises.appendFile('/log', 'second\n')
    expect(openCalls).toEqual([{ path: '/log', flags: 'a' }])
    expect(new TextDecoder().decode(files.get('/log'))).toBe('first\nsecond\n')
  })

  it('access resolves for an existing path and rejects Node-shaped for a missing one', async () => {
    const { stats } = installFakeOrivon()
    stats.set('/x', { size: 1, isFile: true, isDirectory: false, mtimeMs: 0 })
    const { promises } = await import('../node-fs-promises.js')
    await expect(promises.access('/x')).resolves.toBeUndefined()
    await expect(promises.access('/missing')).rejects.toMatchObject({ code: 'notFound' })
  })

  it('unlink rides rm with no options', async () => {
    installFakeOrivon()
    const { promises } = await import('../node-fs-promises.js')
    await expect(promises.unlink('/x')).resolves.toBeUndefined()
  })

  it('mkdir / readdir / stat / rm / rename all resolve through the same core as the callback family', async () => {
    const { stats } = installFakeOrivon()
    stats.set('/piece-0', { size: 10, isFile: true, isDirectory: false, mtimeMs: 1000 })
    const { promises } = await import('../node-fs-promises.js')
    await expect(promises.mkdir('/torrents/abc', { recursive: true })).resolves.toBeUndefined()
    await expect(promises.readdir('/torrents')).resolves.toEqual(['a.bin', 'b.bin'])
    const stat = await promises.stat('/piece-0')
    expect(stat.isFile()).toBe(true)
    await expect(promises.rm('/x', { recursive: true })).resolves.toBeUndefined()
    await expect(promises.rename('/a', '/b')).resolves.toBeUndefined()
  })

  it('open routes to the same fs.open/local-cursor mechanism as the callback family', async () => {
    const { openCalls } = installFakeOrivon()
    const { promises } = await import('../node-fs-promises.js')
    const handle = await promises.open('/piece-0', 'r+')
    expect(typeof handle.fd).toBe('number')
    expect(openCalls).toEqual([{ path: '/piece-0', flags: 'r+' }])
  })

  it('constants carries the same object fs.constants does', async () => {
    installFakeOrivon()
    const { promises } = await import('../node-fs-promises.js')
    expect(promises.constants).toEqual({ F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 })
  })

  it('every other member is named, not silently absent (A135) -- reading one is safe (A169), only calling it refuses', async () => {
    installFakeOrivon()
    const { promises } = await import('../node-fs-promises.js')
    const { OrivonShimError } = await import('../errors.js')
    const rec = promises as unknown as Record<string, () => unknown>
    expect(() => rec.watch).not.toThrow()
    expect(() => rec.watch!()).toThrow(OrivonShimError)
  })
})
