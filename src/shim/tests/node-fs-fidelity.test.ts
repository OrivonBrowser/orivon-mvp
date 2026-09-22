// Node fs behaviours a ported dependency relies on beyond the basic calls:
// readdir's Dirents, writeFile's flag, rm's force, open's default flags,
// append-mode write streams, and close without a callback.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Orivon } from '../../contracts/capability-api.js'
import type { FileStat } from '../../contracts/handles.js'
import { createFakeFileHandle } from './support/fake-file-handle.js'
import { PageBuffer } from './support/page-buffer.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }

function orivonError (code: string, platformCode: string): Error {
  return Object.assign(new Error(`${code} failure`), { name: 'OrivonError', code, platformCode })
}

const FILE: FileStat = { size: 1, isFile: true, isDirectory: false, mtimeMs: 0 }
const DIR: FileStat = { size: 0, isFile: false, isDirectory: true, mtimeMs: 0 }

function installFakeOrivon (files: Map<string, Uint8Array> = new Map()) {
  const openCalls: Array<{ path: string, flags: string }> = []
  const rmCalls: string[] = []
  const writeFileCalls: string[] = []
  ;(globalThis as GlobalWithOrivon).orivon = {
    fs: {
      readdir: async (path: string) => { if (path !== 'data') throw orivonError('notFound', 'ENOENT'); return ['a.txt', 'sub'] },
      stat: async (path: string) => {
        if (path === 'data/a.txt') return FILE
        if (path === 'data/sub') return DIR
        throw orivonError('notFound', 'ENOENT')
      },
      rm: async (path: string) => { rmCalls.push(path); if (!files.has(path)) throw orivonError('notFound', 'ENOENT'); files.delete(path) },
      writeFile: async (path: string, data: Uint8Array) => { writeFileCalls.push(path); files.set(path, data) },
      open: async (path: string, flags: string) => {
        openCalls.push({ path, flags })
        const fake = createFakeFileHandle(files.get(path) ?? new Uint8Array(0))
        const write = fake.handle.write.bind(fake.handle)
        fake.handle.write = async (opts) => { const n = await write(opts); files.set(path, fake.bytes()); return n }
        return fake.handle
      }
    }
  } as unknown as Orivon
  return { files, openCalls, rmCalls, writeFileCalls }
}

afterEach(() => {
  delete (globalThis as GlobalWithOrivon).orivon
  vi.resetModules()
})

describe('readdir', () => {
  it('withFileTypes returns Dirents that know what each entry is', async () => {
    installFakeOrivon()
    const { promises } = await import('../node-fs.js')
    const entries = await promises.readdir('data', { withFileTypes: true })
    expect(entries.map((entry) => [entry.name, entry.isFile(), entry.isDirectory(), entry.isSymbolicLink()])).toEqual([
      ['a.txt', true, false, false],
      ['sub', false, true, false]
    ])
    expect(entries[0]).toMatchObject({ parentPath: 'data', path: 'data' })
  })

  it('the callback form takes the same options', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    const names = await new Promise<unknown>((resolve, reject) => {
      fs.readdir('data', { withFileTypes: true }, (err, result) => (err !== null ? reject(err) : resolve(result)))
    })
    expect((names as Array<{ name: string }>).map((entry) => entry.name)).toEqual(['a.txt', 'sub'])
  })

  it('encoding \'buffer\' returns names as Buffers', async () => {
    installFakeOrivon()
    const { promises } = await import('../node-fs.js')
    const names = await promises.readdir('data', { encoding: 'buffer' })
    expect(names.every((name) => PageBuffer.isBuffer(name))).toBe(true)
    expect(names.map(String)).toEqual(['a.txt', 'sub'])
  })
})

describe('writeFile', () => {
  it('flag \'a\' appends instead of replacing', async () => {
    const { files, openCalls } = installFakeOrivon(new Map([['log', new TextEncoder().encode('one\n')]]))
    const { promises } = await import('../node-fs.js')
    await promises.writeFile('log', 'two\n', { flag: 'a' })
    expect(new TextDecoder().decode(files.get('log'))).toBe('one\ntwo\n')
    expect(openCalls).toEqual([{ path: 'log', flags: 'a' }])
  })

  it('any other flag opens with it, so \'wx\' reaches the broker as exclusive create', async () => {
    const { openCalls, writeFileCalls } = installFakeOrivon()
    const { promises } = await import('../node-fs.js')
    await promises.writeFile('new', 'x', { flag: 'wx' })
    expect(openCalls).toEqual([{ path: 'new', flags: 'wx' }])
    expect(writeFileCalls).toEqual([])
  })

  it('flag \'w\', or none, is one whole-file write', async () => {
    const { openCalls, writeFileCalls } = installFakeOrivon()
    const fs = await import('../node-fs.js')
    await fs.promises.writeFile('a', 'x', { flag: 'w' })
    await new Promise<void>((resolve, reject) => fs.writeFile('b', 'y', { flag: 'w' }, (err) => (err !== null ? reject(err) : resolve())))
    expect(writeFileCalls).toEqual(['a', 'b'])
    expect(openCalls).toEqual([])
  })
})

describe('rm', () => {
  it('force ignores a missing path', async () => {
    installFakeOrivon()
    const { promises } = await import('../node-fs.js')
    await expect(promises.rm('missing', { force: true })).resolves.toBeUndefined()
  })

  it('without force a missing path is still ENOENT', async () => {
    installFakeOrivon()
    const { promises } = await import('../node-fs.js')
    await expect(promises.rm('missing')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('fs.open', () => {
  it('defaults flags to \'r\' when they are omitted', async () => {
    const { openCalls } = installFakeOrivon()
    const fs = await import('../node-fs.js')
    const fd = await new Promise<number>((resolve, reject) => fs.open('a', (err, result) => (err !== null ? reject(err) : resolve(result as number))))
    expect(typeof fd).toBe('number')
    await fs.promises.open('b')
    expect(openCalls).toEqual([{ path: 'a', flags: 'r' }, { path: 'b', flags: 'r' }])
  })

  it('close without a callback closes quietly, with no unhandled rejection', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    const fd = await new Promise<number>((resolve, reject) => fs.open('a', 'r', (err, result) => (err !== null ? reject(err) : resolve(result as number))))
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      fs.close(fd)
      await new Promise((resolve) => setTimeout(resolve, 10))
    } finally {
      process.off('unhandledRejection', unhandled)
    }
    expect(unhandled).not.toHaveBeenCalled()
  })
})

describe('createWriteStream', () => {
  it('flags \'a\' appends after what is there, never at position 0', async () => {
    const { files } = installFakeOrivon(new Map([['log', new TextEncoder().encode('one\n')]]))
    const { createWriteStream } = await import('../node-fs.js')
    const stream = createWriteStream('log', { flags: 'a' })
    await new Promise<void>((resolve) => { stream.end('two\n', () => resolve()) })
    expect(new TextDecoder().decode(files.get('log'))).toBe('one\ntwo\n')
  })
})
