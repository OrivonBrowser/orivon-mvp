// fs.copyFile, fs.cp and fs.mkdtemp (fs/copy.ts), callback and promise forms, over a real directory standing in
// for the app's files and an in-memory picked folder: what they copy, what they refuse and with which error, and
// that none of them reaches a path a read and a write could not.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Orivon } from '../../../contracts/capability-api.js'
import { createFakeDirectoryHandle } from '../../tests/support/fake-directory-handle.js'
import { createRealDiskFs, type RealDiskFs } from '../../tests/support/real-disk-fs.js'
import { VIRTUAL_ROOT, VIRTUAL_TMPDIR } from '../../virtual-root.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }
type Callback = (error: Error | null, value?: unknown) => void

let disk: RealDiskFs | undefined

afterEach(async () => {
  delete (globalThis as GlobalWithOrivon).orivon
  vi.restoreAllMocks()
  vi.resetModules()
  await disk?.cleanup()
  disk = undefined
})

async function load () {
  disk = await createRealDiskFs()
  ;(globalThis as GlobalWithOrivon).orivon = disk.orivon
  const registry = await import('../../../shim-electron/picked-paths.js')
  const fs = await import('../fs.js')
  const { promises } = fs
  const fake = createFakeDirectoryHandle()
  return { disk, fs, promises, fake, pickedRoot: registry.registerPickedDirectory(fake.handle), registry }
}

/** Runs a callback-style call and settles with its `(error, value)`. */
async function called (run: (done: Callback) => void): Promise<{ error: Error | null, value: unknown }> {
  return await new Promise((resolve) => { run((error, value) => { resolve({ error, value }) }) })
}

async function rejection (promise: Promise<unknown>): Promise<Error & { code?: string, syscall?: string, path?: string, dest?: string }> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('did not reject')
}

async function seedTree (promises: Awaited<ReturnType<typeof load>>['promises']): Promise<void> {
  await promises.mkdir('src/sub/deep', { recursive: true })
  await promises.mkdir('src/empty')
  await promises.writeFile('src/top.txt', 'top')
  await promises.writeFile('src/sub/mid.txt', 'mid')
  await promises.writeFile('src/sub/deep/leaf.txt', 'leaf')
}

/** Every path under `dir`, relative to it, with a trailing slash on a folder. */
async function listTree (promises: Awaited<ReturnType<typeof load>>['promises'], dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const name of [...await promises.readdir(dir)].sort()) {
    const isDirectory = (await promises.stat(`${dir}/${name}`)).isDirectory()
    out.push(`${prefix}${name}${isDirectory ? '/' : ''}`)
    if (isDirectory) out.push(...await listTree(promises, `${dir}/${name}`, `${prefix}${name}/`))
  }
  return out
}

const TREE = ['empty/', 'sub/', 'sub/deep/', 'sub/deep/leaf.txt', 'sub/mid.txt', 'top.txt']

describe('fs.copyFile', () => {
  it('copies the bytes to the destination and leaves the source', async () => {
    const { promises } = await load()
    const bytes = new Uint8Array([0, 255, 1, 128, 7])
    await promises.writeFile('a.bin', bytes)
    await promises.copyFile('a.bin', 'b.bin')
    expect(new Uint8Array(await promises.readFile('b.bin') as Uint8Array)).toEqual(bytes)
    expect(new Uint8Array(await promises.readFile('a.bin') as Uint8Array)).toEqual(bytes)
  })

  it('overwrites a destination that exists', async () => {
    const { promises } = await load()
    await promises.writeFile('a.txt', 'new')
    await promises.writeFile('b.txt', 'a much longer old text')
    await promises.copyFile('a.txt', 'b.txt')
    expect(await promises.readFile('b.txt', 'utf8')).toBe('new')
  })

  it('answers the callback form with null, with and without a mode', async () => {
    const { fs, promises, disk: real } = await load()
    await promises.writeFile('a.txt', 'text')
    expect((await called((done) => { fs.copyFile('a.txt', 'b.txt', done) })).error).toBeNull()
    expect((await called((done) => { fs.copyFile('a.txt', 'c.txt', 0, done) })).error).toBeNull()
    expect(await real.readRealFile('b.txt')).toBe('text')
    expect(await real.readRealFile('c.txt')).toBe('text')
  })

  it('is on the default export and on the fs/promises module, the one object', async () => {
    const { fs, promises } = await load()
    const module = await import('../promises.js')
    expect(fs.default.copyFile).toBe(fs.copyFile)
    expect(promises.copyFile).toBe(module.copyFile)
    expect(module.default.copyFile).toBe(module.copyFile)
  })

  it('with the exclusive mode refuses a destination that exists, names both paths, and leaves it alone', async () => {
    const { promises } = await load()
    await promises.writeFile('a.txt', 'new')
    await promises.writeFile('b.txt', 'old')
    const error = await rejection(promises.copyFile('a.txt', 'b.txt', 1))
    expect(error).toMatchObject({ code: 'EEXIST', syscall: 'copyfile', path: 'a.txt', dest: 'b.txt' })
    expect(error.message).toBe("EEXIST: file already exists, copyfile 'a.txt' -> 'b.txt'")
    expect(await promises.readFile('b.txt', 'utf8')).toBe('old')
    await promises.copyFile('a.txt', 'fresh.txt', 1)
    expect(await promises.readFile('fresh.txt', 'utf8')).toBe('new')
  })

  it('refuses a folder as the source (EISDIR), a missing source (ENOENT), a folder as the destination (EISDIR) and a missing parent (ENOENT)', async () => {
    const { promises } = await load()
    await promises.mkdir('dir')
    await promises.writeFile('a.txt', 'text')
    expect(await rejection(promises.copyFile('dir', 'x'))).toMatchObject({ code: 'EISDIR', syscall: 'copyfile', path: 'dir', dest: 'x' })
    expect(await rejection(promises.copyFile('missing', 'x'))).toMatchObject({ code: 'ENOENT' })
    expect(await rejection(promises.copyFile('a.txt', 'dir'))).toMatchObject({ code: 'EISDIR', syscall: 'copyfile' })
    expect(await rejection(promises.copyFile('a.txt', 'no/such/parent.txt'))).toMatchObject({ code: 'ENOENT' })
    expect(await rejection(promises.copyFile(VIRTUAL_ROOT, 'x'))).toMatchObject({ code: 'EISDIR' })
  })

  it('copying a file onto itself leaves it intact', async () => {
    const { promises } = await load()
    await promises.writeFile('a.txt', 'same')
    await promises.copyFile('a.txt', `${VIRTUAL_ROOT}/a.txt`)
    expect(await promises.readFile('a.txt', 'utf8')).toBe('same')
  })

  it('checks its arguments as Node does: a mode out of range or not a number, a path that is not a path, a missing callback', async () => {
    const { fs, promises, disk: real } = await load()
    await promises.writeFile('a.txt', 'text')
    expect(await rejection(promises.copyFile('a.txt', 'b.txt', 9))).toMatchObject({ code: 'ERR_OUT_OF_RANGE' })
    expect(await rejection(promises.copyFile('a.txt', 'b.txt', 'x' as never))).toMatchObject({ code: 'ERR_INVALID_ARG_TYPE' })
    expect(await rejection(promises.copyFile(5 as never, 'b.txt'))).toMatchObject({ code: 'ERR_INVALID_ARG_TYPE' })
    expect(() => { (fs.copyFile as (...args: unknown[]) => void)('a.txt', 'b.txt') }).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }))
    expect(await real.existsOnDisk('b.txt')).toBe(false)
  })

  it('reaches only the app\'s files and a picked path: outside them it fails EACCES and the broker is not asked', async () => {
    const { promises, disk: real } = await load()
    await promises.writeFile('a.txt', 'text')
    const spies = [vi.spyOn(real.orivon.fs, 'readFile'), vi.spyOn(real.orivon.fs, 'writeFile'), vi.spyOn(real.orivon.fs, 'open')]
    for (const [from, to] of [['/etc/passwd', 'x'], ['a.txt', '/etc/x'], ['../a.txt', 'x'], ['a.txt', '../escaped.txt']]) {
      expect(await rejection(promises.copyFile(from!, to!)), `${from} -> ${to}`).toMatchObject({ code: 'EACCES' })
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('copies from a picked folder into the app\'s files, the other way, and inside the pick', async () => {
    const { promises, fake, pickedRoot } = await load()
    fake.put('docs/a.txt', 'from the pick')
    await promises.copyFile(`${pickedRoot}/docs/a.txt`, 'copied.txt')
    expect(await promises.readFile('copied.txt', 'utf8')).toBe('from the pick')
    await promises.writeFile('local.txt', 'from the app')
    await promises.copyFile('local.txt', `${pickedRoot}/docs/local.txt`)
    expect(new TextDecoder().decode(fake.bytes('docs/local.txt'))).toBe('from the app')
    await promises.copyFile(`${pickedRoot}/docs/a.txt`, `${pickedRoot}/docs/b.txt`)
    expect(new TextDecoder().decode(fake.bytes('docs/b.txt'))).toBe('from the pick')
  })

  it('copies a picked file, and cannot write beside it', async () => {
    const { promises, registry } = await load()
    const single = createFakeDirectoryHandle()
    single.put('note.md', 'one note')
    const path = registry.registerPickedFile(await single.handle.open('note.md', 'r+'), 'note.md')
    await promises.copyFile(path, 'note-copy.md')
    expect(await promises.readFile('note-copy.md', 'utf8')).toBe('one note')
    expect(await rejection(promises.copyFile('note-copy.md', `${path}.bak`))).toMatchObject({ code: 'EACCES' })
  })
})

describe('fs.cp', () => {
  it('copies a folder tree recursively, empty folders included, and leaves the source', async () => {
    const { promises } = await load()
    await seedTree(promises)
    await promises.cp('src', 'dst', { recursive: true })
    expect(await listTree(promises, 'dst')).toEqual(TREE)
    expect(await listTree(promises, 'src')).toEqual(TREE)
    expect(await promises.readFile('dst/sub/deep/leaf.txt', 'utf8')).toBe('leaf')
  })

  it('refuses a folder without the recursive option (ERR_FS_EISDIR) and writes nothing', async () => {
    const { promises, disk: real } = await load()
    await seedTree(promises)
    const error = await rejection(promises.cp('src', 'dst'))
    expect(error).toMatchObject({ code: 'ERR_FS_EISDIR', syscall: 'cp', path: 'src' })
    expect(error.message).toBe('Path is a directory: cp returned EISDIR (src is a directory (not copied))')
    expect(await real.existsOnDisk('dst')).toBe(false)
  })

  it('copies one file and makes the destination\'s missing folders', async () => {
    const { promises } = await load()
    await promises.writeFile('a.txt', 'text')
    await promises.cp('a.txt', 'n1/n2/a.txt')
    expect(await promises.readFile('n1/n2/a.txt', 'utf8')).toBe('text')
  })

  it('merges into a destination folder that exists and overwrites its files by default', async () => {
    const { promises } = await load()
    await seedTree(promises)
    await promises.mkdir('dst/sub', { recursive: true })
    await promises.writeFile('dst/top.txt', 'old')
    await promises.writeFile('dst/keep.txt', 'kept')
    await promises.cp('src', 'dst', { recursive: true })
    expect(await promises.readFile('dst/top.txt', 'utf8')).toBe('top')
    expect(await promises.readFile('dst/keep.txt', 'utf8')).toBe('kept')
    expect(await listTree(promises, 'dst')).toEqual(['empty/', 'keep.txt', ...TREE.slice(1)])
  })

  it('force: false keeps a file that exists, and errorOnExist makes that an error (ERR_FS_CP_EEXIST)', async () => {
    const { promises } = await load()
    await promises.writeFile('a.txt', 'new')
    await promises.writeFile('b.txt', 'old')
    await promises.cp('a.txt', 'b.txt', { force: false })
    expect(await promises.readFile('b.txt', 'utf8')).toBe('old')
    const error = await rejection(promises.cp('a.txt', 'b.txt', { force: false, errorOnExist: true }))
    expect(error).toMatchObject({ code: 'ERR_FS_CP_EEXIST', syscall: 'cp' })
    expect(error.message).toBe('Target already exists: cp returned EEXIST (b.txt already exists)')
    expect(await promises.readFile('b.txt', 'utf8')).toBe('old')
  })

  it('asks filter for every entry, first one included, and skips what it refuses, a promise answer too', async () => {
    const { promises } = await load()
    await seedTree(promises)
    const asked: string[] = []
    await promises.cp('src', 'dst', {
      recursive: true,
      filter: async (from, to) => { asked.push(`${from} ${to}`); return !from.endsWith('deep') && !from.endsWith('top.txt') }
    })
    expect(asked).toContain('src dst')
    expect(asked).toContain('src/sub/deep dst/sub/deep')
    expect(await listTree(promises, 'dst')).toEqual(['empty/', 'sub/', 'sub/mid.txt'])
    await promises.cp('src', 'plain', { recursive: true, filter: (from) => !from.endsWith('empty') })
    expect(await listTree(promises, 'plain')).toEqual(TREE.slice(1))
  })

  it('refuses a folder over a file, a file over a folder, a path onto itself and a folder into itself, writing nothing', async () => {
    const { promises } = await load()
    await seedTree(promises)
    await promises.writeFile('file.txt', 'f')
    expect(await rejection(promises.cp('src', 'file.txt', { recursive: true }))).toMatchObject({ code: 'ERR_FS_CP_DIR_TO_NON_DIR', syscall: 'cp' })
    expect(await rejection(promises.cp('file.txt', 'src', { recursive: true }))).toMatchObject({ code: 'ERR_FS_CP_NON_DIR_TO_DIR', syscall: 'cp' })
    expect(await rejection(promises.cp('file.txt', `${VIRTUAL_ROOT}/file.txt`))).toMatchObject({ code: 'ERR_FS_CP_EINVAL' })
    const inside = await rejection(promises.cp('src', 'src/sub/copy', { recursive: true }))
    expect(inside).toMatchObject({ code: 'ERR_FS_CP_EINVAL' })
    expect(inside.message).toBe('Invalid src or dest: cp returned EINVAL (cannot copy src to a subdirectory of self src/sub/copy)')
    expect(await rejection(promises.cp(VIRTUAL_ROOT, 'backup', { recursive: true }))).toMatchObject({ code: 'ERR_FS_CP_EINVAL' })
    expect(await listTree(promises, 'src')).toEqual(TREE)
    expect(await promises.readFile('file.txt', 'utf8')).toBe('f')
  })

  it('fails ENOENT for a missing source, and checks its options as Node does', async () => {
    const { fs, promises, disk: real } = await load()
    await promises.writeFile('a.txt', 'text')
    expect(await rejection(promises.cp('missing', 'x'))).toMatchObject({ code: 'ENOENT' })
    expect(await rejection(promises.cp('a.txt', 'b.txt', { recursive: 'yes' } as never))).toMatchObject({ code: 'ERR_INVALID_ARG_TYPE' })
    expect(await rejection(promises.cp('a.txt', 'b.txt', { filter: 1 } as never))).toMatchObject({ code: 'ERR_INVALID_ARG_TYPE' })
    expect(await rejection(promises.cp('a.txt', 'b.txt', 'x' as never))).toMatchObject({ code: 'ERR_INVALID_ARG_TYPE' })
    expect(() => { (fs.cp as (...args: unknown[]) => void)('a.txt', 'b.txt') }).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }))
    expect(await real.existsOnDisk('b.txt')).toBe(false)
    expect(await real.existsOnDisk('x')).toBe(false)
  })

  it('answers the callback form, with and without options', async () => {
    const { fs, promises } = await load()
    await seedTree(promises)
    expect((await called((done) => { fs.cp('src/top.txt', 'one.txt', done) })).error).toBeNull()
    expect((await called((done) => { fs.cp('src', 'dst', { recursive: true }, done) })).error).toBeNull()
    expect(await listTree(promises, 'dst')).toEqual(TREE)
    expect((await called((done) => { fs.cp('src', 'again', done) })).error).toMatchObject({ code: 'ERR_FS_EISDIR' })
  })

  it('is on the default export and on the fs/promises module, the one object', async () => {
    const { fs, promises } = await load()
    const module = await import('../promises.js')
    expect(fs.default.cp).toBe(fs.cp)
    expect(promises.cp).toBe(module.cp)
    expect(module.default.cp).toBe(module.cp)
  })

  it('reaches only the app\'s files and a picked path: a source or destination outside fails EACCES and nothing is written', async () => {
    const { promises, disk: real } = await load()
    await seedTree(promises)
    const writes = [vi.spyOn(real.orivon.fs, 'writeFile'), vi.spyOn(real.orivon.fs, 'mkdir')]
    for (const [from, to] of [['/etc', 'x'], ['src', '/etc/x'], ['../src', 'x'], ['src', '../escaped']]) {
      expect(await rejection(promises.cp(from!, to!, { recursive: true })), `${from} -> ${to}`).toMatchObject({ code: 'EACCES' })
    }
    for (const spy of writes) expect(spy).not.toHaveBeenCalled()
  })

  it('copies a tree into a picked folder and out of it, and inside it', async () => {
    const { promises, fake, pickedRoot } = await load()
    await seedTree(promises)
    await promises.cp('src', `${pickedRoot}/backup`, { recursive: true })
    expect(await listTree(promises, `${pickedRoot}/backup`)).toEqual(TREE)
    expect(new TextDecoder().decode(fake.bytes('backup/sub/deep/leaf.txt'))).toBe('leaf')
    await promises.cp(`${pickedRoot}/backup`, 'restored', { recursive: true })
    expect(await listTree(promises, 'restored')).toEqual(TREE)
    await promises.cp(`${pickedRoot}/backup/sub`, `${pickedRoot}/sub-copy`, { recursive: true })
    expect(await listTree(promises, `${pickedRoot}/sub-copy`)).toEqual(['deep/', 'deep/leaf.txt', 'mid.txt'])
    expect(await rejection(promises.cp(`${pickedRoot}/backup`, `${pickedRoot}/backup/inner`, { recursive: true }))).toMatchObject({ code: 'ERR_FS_CP_EINVAL' })
  })
})

describe('fs.mkdtemp', () => {
  it('makes a new folder named the prefix and twelve random characters, and returns its path', async () => {
    const { promises, disk: real } = await load()
    await promises.mkdir('work')
    const path = await promises.mkdtemp('work/job-') as string
    expect(path).toMatch(/^work\/job-[A-Za-z0-9]{12}$/)
    expect((await promises.stat(path)).isDirectory()).toBe(true)
    expect(await real.existsOnDisk(path)).toBe(true)
    expect(await promises.readdir(path)).toEqual([])
  })

  it('makes a different folder every call', async () => {
    const { promises } = await load()
    const names = new Set<string>()
    for (let call = 0; call < 20; call++) names.add(await promises.mkdtemp('t-') as string)
    expect(names.size).toBe(20)
  })

  it('works under os.tmpdir(), which is inside the app\'s files, with no folder made first', async () => {
    const { promises, disk: real } = await load()
    const path = await promises.mkdtemp(`${VIRTUAL_TMPDIR}/zen-`) as string
    expect(path.startsWith(`${VIRTUAL_TMPDIR}/zen-`)).toBe(true)
    expect(await real.existsOnDisk(path.slice(VIRTUAL_ROOT.length + 1))).toBe(true)
    await promises.rm(path, { recursive: true })
    expect(await real.existsOnDisk(path.slice(VIRTUAL_ROOT.length + 1))).toBe(false)
  })

  it('answers the callback form with the path, and returns a Buffer for the buffer encoding', async () => {
    const { fs } = await load()
    const { error, value } = await called((done) => { fs.mkdtemp('cb-', done) })
    expect(error).toBeNull()
    expect(value).toMatch(/^cb-[A-Za-z0-9]{12}$/)
    const buffered = await called((done) => { fs.mkdtemp('buf-', { encoding: 'buffer' }, done) })
    expect(Buffer.from(buffered.value as Uint8Array).toString()).toMatch(/^buf-[A-Za-z0-9]{12}$/)
    const asString = await called((done) => { fs.mkdtemp('str-', 'utf8', done) })
    expect(asString.value).toMatch(/^str-/)
  })

  it('draws again when a name is taken, and gives up with EEXIST when every draw is taken', async () => {
    const { promises, disk: real } = await load()
    const zeros = (array: Uint8Array): Uint8Array => array.fill(0)
    await promises.mkdir('x-AAAAAAAAAAAA')
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues')
    spy.mockImplementationOnce(zeros as never)
    const path = await promises.mkdtemp('x-') as string
    expect(path).not.toBe('x-AAAAAAAAAAAA')
    expect(await real.existsOnDisk(path)).toBe(true)
    spy.mockImplementation(zeros as never)
    expect(await rejection(promises.mkdtemp('x-'))).toMatchObject({ code: 'EEXIST', syscall: 'mkdtemp' })
  })

  it('needs its parent folder (ENOENT), and checks its prefix', async () => {
    const { fs, promises } = await load()
    expect(await rejection(promises.mkdtemp('no/such/parent-'))).toMatchObject({ code: 'ENOENT' })
    expect(await rejection(promises.mkdtemp(5 as never))).toMatchObject({ code: 'ERR_INVALID_ARG_TYPE' })
    expect(await rejection(promises.mkdtemp(undefined as never))).toMatchObject({ code: 'ERR_INVALID_ARG_TYPE' })
    expect(() => { (fs.mkdtemp as (...args: unknown[]) => void)('x-') }).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }))
  })

  it('reaches only the app\'s files and a picked folder: a prefix outside fails EACCES and no folder is made', async () => {
    const { promises, disk: real } = await load()
    const mkdir = vi.spyOn(real.orivon.fs, 'mkdir')
    for (const prefix of ['/etc/tmp-', '../tmp-', '/tmp/tmp-']) {
      expect(await rejection(promises.mkdtemp(prefix)), prefix).toMatchObject({ code: 'EACCES' })
    }
    expect(mkdir).not.toHaveBeenCalled()
  })

  it('makes its folder inside a picked folder', async () => {
    const { promises, fake, pickedRoot } = await load()
    fake.put('docs/a.txt', 'alpha')
    const path = await promises.mkdtemp(`${pickedRoot}/docs/tmp-`) as string
    expect(path.startsWith(`${pickedRoot}/docs/tmp-`)).toBe(true)
    expect(await promises.readdir(`${pickedRoot}/docs`)).toHaveLength(2)
    expect((await promises.stat(path)).isDirectory()).toBe(true)
  })
})
