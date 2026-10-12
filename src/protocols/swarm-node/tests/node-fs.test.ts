import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WasiFs } from '../../../shim/wasi/context.js'
import { MAX_OPEN_FILES, createConfinedFs } from '../node-fs.js'

let base: string
let outside: string
let root: string
let fs: WasiFs

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'swarm-node-fs-'))
  outside = join(base, 'outside')
  root = join(base, 'data')
  await mkdir(outside)
  await writeFile(join(outside, 'secret.txt'), 'secret')
  fs = await createConfinedFs(root)
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

describe('inside the directory', () => {
  it('creates, writes, reads, lists, renames and removes a file', async () => {
    const created = await fs.open('a.txt', 'wx+')
    await created.write({ position: 0, data: new TextEncoder().encode('hello') })
    expect(text(await created.read({ position: 1, length: 3 }))).toBe('ell')
    expect((await created.stat()).size).toBe(5)
    await created.truncate(2)
    await created.sync()
    await created.close()
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('he')
    await fs.mkdir('sub/deeper', { recursive: true })
    await fs.rename('a.txt', 'sub/b.txt')
    expect(await fs.readdir('sub')).toEqual(expect.arrayContaining(['b.txt', 'deeper']))
    expect(await fs.readdir('.')).toEqual(['sub'])
    expect((await fs.stat('sub')).isDirectory).toBe(true)
    expect((await fs.stat('.')).isDirectory).toBe(true)
    await fs.rm('sub/b.txt')
    await fs.rm('sub', { recursive: true })
    expect(await fs.readdir('.')).toEqual([])
  })

  it('reads at most a bounded piece however large the length asked', async () => {
    await writeFile(join(root, 'small'), 'abc')
    const file = await fs.open('small', 'r')
    expect(text(await file.read({ position: 0, length: 2 ** 40 }))).toBe('abc')
    await file.close()
  })

  it('accepts a path that goes up and comes back down inside', async () => {
    await mkdir(join(root, 'x'))
    await writeFile(join(root, 'f'), 'ok')
    expect((await fs.stat('x/../f')).isFile).toBe(true)
  })
})

describe('errors the WASI host reads', () => {
  it('names a missing file notFound with the errno as the platform code', async () => {
    await expect(fs.stat('missing')).rejects.toMatchObject({ code: 'notFound', platformCode: 'ENOENT' })
    await expect(fs.open('missing', 'r')).rejects.toMatchObject({ code: 'notFound', platformCode: 'ENOENT' })
    await expect(fs.open('nodir/x', 'wx')).rejects.toMatchObject({ code: 'notFound', platformCode: 'ENOENT' })
  })

  it('names an exclusive create of an existing file exists', async () => {
    await writeFile(join(root, 'there'), '')
    await expect(fs.open('there', 'wx')).rejects.toMatchObject({ code: 'exists', platformCode: 'EEXIST' })
  })

  it('keeps ENOTEMPTY and EISDIR', async () => {
    await mkdir(join(root, 'full'))
    await writeFile(join(root, 'full', 'f'), '')
    await expect(fs.rm('full')).rejects.toMatchObject({ platformCode: expect.stringMatching(/^(EISDIR|ERR_FS_EISDIR|ENOTEMPTY)$/) as string })
    await expect(fs.open('full', 'r+')).rejects.toMatchObject({ platformCode: 'EISDIR' })
  })

  it('refuses flags the host never sends', async () => {
    await expect(fs.open('x', 'ax+')).rejects.toMatchObject({ code: 'invalid' })
  })
})

describe('confinement', () => {
  it.each(['..', '../outside/secret.txt', 'a/../../outside/secret.txt', '../data/../outside'])('refuses %s', async (path) => {
    await expect(fs.open(path, 'r')).rejects.toMatchObject({ code: 'denied' })
    await expect(fs.stat(path)).rejects.toMatchObject({ code: 'denied' })
    await expect(fs.readdir(path)).rejects.toMatchObject({ code: 'denied' })
    await expect(fs.mkdir(path)).rejects.toMatchObject({ code: 'denied' })
    await expect(fs.rm(path)).rejects.toMatchObject({ code: 'denied' })
    await expect(fs.rename(path, 'x')).rejects.toMatchObject({ code: 'denied' })
    await expect(fs.rename('x', path)).rejects.toMatchObject({ code: 'denied' })
  })

  it('refuses an absolute path, even to a file that exists', async () => {
    await expect(fs.open(join(outside, 'secret.txt'), 'r')).rejects.toMatchObject({ code: 'denied' })
    await expect(fs.stat('/etc/passwd')).rejects.toMatchObject({ code: 'denied' })
  })

  it('refuses a symlinked directory that leads out, for reads, listing and creates', async () => {
    await symlink(outside, join(root, 'link'))
    await expect(fs.readdir('link')).rejects.toMatchObject({ code: 'denied' })
    await expect(fs.open('link/secret.txt', 'r')).rejects.toMatchObject({ code: 'denied' })
    await expect(fs.open('link/new.txt', 'wx')).rejects.toMatchObject({ code: 'denied' })
    await expect(fs.mkdir('link/newdir')).rejects.toMatchObject({ code: 'denied' })
  })

  it('refuses a symlinked file that leads out', async () => {
    await symlink(join(outside, 'secret.txt'), join(root, 'filelink'))
    await expect(fs.open('filelink', 'r')).rejects.toMatchObject({ code: 'denied' })
    await expect(fs.stat('filelink')).rejects.toMatchObject({ code: 'denied' })
    await expect(fs.open('filelink', 'w')).rejects.toMatchObject({ code: 'denied' })
  })

  it('refuses a dangling symlink, which opening for writing would follow out', async () => {
    await symlink(join(outside, 'not-yet'), join(root, 'dangling'))
    await symlink('dangling', join(root, 'chain'))
    for (const path of ['dangling', 'chain']) {
      await expect(fs.open(path, 'w')).rejects.toMatchObject({ code: 'denied' })
      await expect(fs.open(path, 'wx')).rejects.toMatchObject({ code: 'denied' })
    }
    await expect(readFile(join(outside, 'not-yet'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('allows a symlink that stays inside', async () => {
    await mkdir(join(root, 'real'))
    await writeFile(join(root, 'real', 'f'), 'in')
    await symlink('real', join(root, 'alias'))
    expect(text(await (await fs.open('alias/f', 'r')).read({ position: 0, length: 10 }))).toBe('in')
  })

  it('never removes or renames the directory itself', async () => {
    await expect(fs.rm('.', { recursive: true })).rejects.toMatchObject({ code: 'denied' })
    await expect(fs.rename('.', 'moved')).rejects.toMatchObject({ code: 'denied' })
    await expect(fs.rename('x', '.')).rejects.toBeDefined()
  })

  it('refuses a path with a NUL', async () => {
    await expect(fs.open('a\0b', 'r')).rejects.toMatchObject({ code: 'denied' })
  })
})

describe('limits', () => {
  it('holds at most 64 files open, and a closed one frees its place', async () => {
    const held = []
    for (let index = 0; index < MAX_OPEN_FILES; index++) held.push(await fs.open(`f${String(index)}`, 'wx'))
    await expect(fs.open('one-more', 'wx')).rejects.toMatchObject({ code: 'limit' })
    await held[0]?.close()
    await expect(fs.open('one-more', 'wx')).resolves.toBeDefined()
    for (const file of held) await file.close()
  })
})
