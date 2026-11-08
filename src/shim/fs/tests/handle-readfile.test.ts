// FileHandle#readFile reads from the handle's current position to the end of the file and moves that position, over
// the same positional reads `read` makes; FileHandle#appendFile is writeFile under its other name. A program that
// opens a settings file and calls `await handle.readFile('utf8')` must get the text, not a TypeError that reads as
// "the file is missing".

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Orivon } from '../../../contracts/capability-api.js'
import type { FileHandle } from '../../../contracts/handles.js'
import { createFakeDirectoryHandle } from '../../tests/support/fake-directory-handle.js'
import { createFakeFileHandle, type FakeFileHandle } from '../../tests/support/fake-file-handle.js'
import { PageBuffer } from '../../tests/support/page-buffer.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }
type Coded = Error & { code?: string }

const MIB = 1024 * 1024
const text = (value: string): Uint8Array => new TextEncoder().encode(value)

/** An orivon whose `open` hands back `handle`, or a fake over `initial` when none is given. */
function install (initial?: Uint8Array, handle?: FileHandle): FakeFileHandle {
  const fake = createFakeFileHandle(initial)
  ;(globalThis as GlobalWithOrivon).orivon = { fs: { open: async () => handle ?? fake.handle } } as unknown as Orivon
  return fake
}

afterEach(() => {
  delete (globalThis as GlobalWithOrivon).orivon
  vi.resetModules()
})

describe('FileHandle#readFile', () => {
  it('returns the whole file as a Buffer with no options, and as text for an encoding in either spelling', async () => {
    install(text('theme=dark\n'))
    const { promises } = await import('../fs.js')
    const handle = await promises.open('settings.ini', 'r')
    const bytes = await handle.readFile()
    expect(PageBuffer.isBuffer(bytes)).toBe(true)
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe('theme=dark\n')
    for (const options of ['utf8', { encoding: 'utf8' }] as const) {
      const again = await promises.open('settings.ini', 'r')
      expect(await again.readFile(options)).toBe('theme=dark\n')
    }
    const hex = await promises.open('settings.ini', 'r')
    expect(await hex.readFile('hex')).toBe(Buffer.from('theme=dark\n').toString('hex'))
    const nothing = await promises.open('settings.ini', 'r')
    expect(PageBuffer.isBuffer(await nothing.readFile({ encoding: null }))).toBe(true)
  })

  it('an empty file is an empty Buffer, or an empty string with an encoding', async () => {
    install()
    const { promises } = await import('../fs.js')
    const handle = await promises.open('empty', 'r')
    expect((await handle.readFile() as Uint8Array).length).toBe(0)
    expect(await (await promises.open('empty', 'r')).readFile('utf8')).toBe('')
  })

  it('reads from the current position and leaves it at the end, so the next read and the next readFile get nothing', async () => {
    const fake = install(text('0123456789'))
    const { promises } = await import('../fs.js')
    const handle = await promises.open('data', 'r')
    const head = await handle.read(new Uint8Array(4))
    expect(head.bytesRead).toBe(4)
    expect(await handle.readFile('utf8')).toBe('456789')
    expect(await handle.readFile('utf8')).toBe('')
    expect((await handle.read(new Uint8Array(4))).bytesRead).toBe(0)
    expect(fake.readCalls[1]).toMatchObject({ position: 4 })
  })

  it('a position given to an earlier read does not move the position readFile starts from', async () => {
    install(text('0123456789'))
    const { promises } = await import('../fs.js')
    const handle = await promises.open('data', 'r')
    await handle.read(new Uint8Array(3), 0, 3, 7)
    expect(await handle.readFile('utf8')).toBe('0123456789')
  })

  it('every read it makes is positional underneath, in chunks of a megabyte, and it stops at the first empty read', async () => {
    const size = 2.5 * MIB
    const bytes = new Uint8Array(size).map((_, index) => index % 251)
    const fake = install(bytes)
    const { promises } = await import('../fs.js')
    const read = await (await promises.open('big.bin', 'r')).readFile() as Uint8Array
    expect(read.length).toBe(size)
    expect(read.every((value, index) => value === bytes[index])).toBe(true)
    expect(fake.readCalls).toEqual([
      { position: 0, length: MIB }, { position: MIB, length: MIB }, { position: 2 * MIB, length: MIB }, { position: size, length: MIB }
    ])
  })

  it('goes on past a read the broker answers short, and loses no byte', async () => {
    const source = createFakeFileHandle(text('abcdefghijklmnopqrstuvwxyz'))
    const capped: FileHandle = { ...source.handle, read: async ({ position, length }) => await source.handle.read({ position, length: Math.min(length, 5) }) }
    install(undefined, capped)
    const { promises } = await import('../fs.js')
    expect(await (await promises.open('capped', 'r')).readFile('utf8')).toBe('abcdefghijklmnopqrstuvwxyz')
  })

  it('an encoding Node does not know rejects ERR_INVALID_ARG_VALUE before a byte is read, and the position stays', async () => {
    const fake = install(text('abc'))
    const { promises } = await import('../fs.js')
    const handle = await promises.open('data', 'r')
    await expect(handle.readFile('not-an-encoding')).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' })
    expect(fake.readCalls).toEqual([])
    expect(await handle.readFile('utf8')).toBe('abc')
  })

  it('a failure of the broker is a Node-shaped rejection, never a synchronous throw', async () => {
    const failing: FileHandle = {
      ...createFakeFileHandle().handle,
      read: async () => { throw Object.assign(new Error('gone'), { name: 'OrivonError', code: 'notFound', platformCode: 'ENOENT' }) }
    }
    install(undefined, failing)
    const { promises } = await import('../fs.js')
    const handle = await promises.open('gone', 'r')
    let pending: Promise<unknown> | undefined
    expect(() => { pending = handle.readFile() }).not.toThrow()
    await expect(pending).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('the app\'s root is a directory: EISDIR, answered locally', async () => {
    install()
    const { promises } = await import('../fs.js')
    const { VIRTUAL_ROOT } = await import('../../virtual-root.js')
    const handle = await promises.open(VIRTUAL_ROOT, 'r')
    const error = await handle.readFile().then(() => undefined, (rejection: Coded) => rejection)
    expect(error?.code).toBe('EISDIR')
  })

  it('is on the default export\'s handles and the callback family\'s open handles alike: one class', async () => {
    install(text('shared'))
    const fs = await import('../fs.js')
    const handle = await fs.promises.open('shared.txt', 'r')
    expect(typeof handle.readFile).toBe('function')
    expect(await handle.readFile('utf8')).toBe('shared')
  })
})

describe('FileHandle#readFile on a picked path', () => {
  async function load () {
    const registry = await import('../../../shim-electron/picked-paths.js')
    const fs = await import('../fs.js')
    return { ...registry, fs }
  }

  it('reads a picked file whole, from where the handle is', async () => {
    install()
    const { registerPickedFile, fs } = await load()
    const file = registerPickedFile(createFakeFileHandle(text('picked file text')).handle, 'note.txt')
    const handle = await fs.promises.open(file, 'r')
    await handle.read(new Uint8Array(7))
    expect(await handle.readFile('utf8')).toBe('file text')
    expect(await (await fs.promises.open(file, 'r')).readFile('utf8')).toBe('picked file text')
  })

  it('reads a file inside a picked folder, and a missing one is ENOENT', async () => {
    install()
    const { registerPickedDirectory, fs } = await load()
    const directory = createFakeDirectoryHandle()
    directory.put('inside.txt', 'in the folder')
    const folder = registerPickedDirectory(directory.handle)
    expect(await (await fs.promises.open(`${folder}/inside.txt`, 'r')).readFile('utf8')).toBe('in the folder')
    await expect(fs.promises.open(`${folder}/missing.txt`, 'r')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('FileHandle#appendFile', () => {
  it('writes at the handle\'s position as writeFile does, so two calls continue one another', async () => {
    const fake = install()
    const { promises } = await import('../fs.js')
    const handle = await promises.open('log.txt', 'w+')
    await handle.appendFile('ab')
    await handle.appendFile('cd')
    await handle.appendFile('0102', 'hex')
    expect([...fake.bytes()]).toEqual([...text('abcd'), 1, 2])
  })
})
