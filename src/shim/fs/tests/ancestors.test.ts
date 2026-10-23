// The directories above the app's files root (`/` and `/orivon`) exist as
// read-only directories that list one entry, the next segment toward the
// root: a program that makes a folder by walking from `/` (stat each
// ancestor, mkdir the ones that are not directories) gets through them.
// Every answer is local: `installUntouchableOrivon` fails the test if the
// shim ever asks orivon.fs about an ancestor, so nothing outside the app's
// own folder becomes readable or writable by this route.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Orivon } from '../../../contracts/capability-api.js'
import { ancestorOf } from '../ancestors.js'
import { VIRTUAL_ROOT } from '../../virtual-root.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }

/** An orivon whose every member throws, in the page's form and the Worker's synchronous twin. */
function installUntouchableOrivon (): string[] {
  const touched: string[] = []
  const members = new Proxy({}, {
    get: (_target, member) => (...args: unknown[]) => { touched.push(`${String(member)}(${String(args[0])})`); throw new Error(`orivon.fs.${String(member)} must not be reached`) }
  })
  ;(globalThis as GlobalWithOrivon).orivon = { fs: members, [Symbol.for('orivon.synchronous')]: { fs: members } } as unknown as Orivon
  return touched
}

afterEach(() => {
  delete (globalThis as GlobalWithOrivon).orivon
  vi.resetModules()
})

const ANCESTORS = ['/', '/orivon', '/orivon/', '//', '/orivon//', '/orivon/app/..', '/orivon/app/../..', '/./orivon', '/orivon/other/..', '/..']
const NOT_ANCESTORS = [VIRTUAL_ROOT, `${VIRTUAL_ROOT}/`, `${VIRTUAL_ROOT}/x`, '/orivon/other', '/orivon/picked', '/etc', '/orivon-x', '/orivon/app2', 'orivon', '.', '..', '']

describe('ancestorOf', () => {
  it.each(ANCESTORS)('%s is an ancestor of the files root', (path) => {
    expect(ancestorOf(path)).toBeDefined()
  })

  it.each(NOT_ANCESTORS)('%j is not', (path) => {
    expect(ancestorOf(path)).toBeUndefined()
  })

  it('names the next segment toward the files root', () => {
    expect(ancestorOf('/')).toEqual({ path: '/', child: 'orivon' })
    expect(ancestorOf('/orivon/')).toEqual({ path: '/orivon', child: 'app' })
  })
})

describe('stat, lstat, access, realpath and existsSync say an ancestor is a directory', () => {
  it.each(['/', '/orivon', '/orivon/'])('%s, in every family, without asking orivon.fs', async (path) => {
    const touched = installUntouchableOrivon()
    const fs = await import('../fs.js')
    const { promises } = fs
    for (const stat of [await promises.stat(path), await promises.lstat(path), fs.statSync(path), fs.lstatSync(path as string)]) {
      expect(stat?.isDirectory()).toBe(true)
      expect(stat?.isFile()).toBe(false)
    }
    const viaCallback = await new Promise<{ isDirectory: () => boolean } | undefined>((resolve, reject) => {
      fs.stat(path, (error, result) => (error !== null ? reject(error) : resolve(result)))
    })
    expect(viaCallback?.isDirectory()).toBe(true)
    expect(fs.existsSync(path)).toBe(true)
    expect(fs.accessSync(path)).toBeUndefined()
    await expect(promises.access(path)).resolves.toBeUndefined()
    expect(fs.realpathSync(path)).toBe(path === '/orivon/' ? '/orivon' : path)
    await expect(promises.realpath(path)).resolves.toBe(path === '/orivon/' ? '/orivon' : path)
    expect(touched).toEqual([])
  })

  it('different ancestors have different inodes, stable per path', async () => {
    installUntouchableOrivon()
    const { promises } = await import('../fs.js')
    const [a, b, again] = [await promises.stat('/'), await promises.stat('/orivon'), await promises.stat('/')]
    expect(a.ino).not.toBe(b.ino)
    expect(a.ino).toBe(again.ino)
  })
})

describe('mkdir of an ancestor is Node\'s outcome for a directory that exists', () => {
  it.each(['/', '/orivon'])('%s: recursive is a no-op, otherwise EEXIST naming the path', async (path) => {
    const touched = installUntouchableOrivon()
    const fs = await import('../fs.js')
    await expect(fs.promises.mkdir(path, { recursive: true })).resolves.toBeUndefined()
    await expect(fs.promises.mkdir(path)).rejects.toMatchObject({ code: 'EEXIST', syscall: 'mkdir', path })
    await expect(fs.promises.mkdir(path, { recursive: false })).rejects.toMatchObject({ code: 'EEXIST' })
    expect(() => fs.mkdirSync(path, { recursive: true })).not.toThrow()
    expect(() => fs.mkdirSync(path)).toThrow(expect.objectContaining({ code: 'EEXIST', path }))
    const error = await new Promise<Error & { code?: string }>((resolve) => { fs.mkdir(path, (err) => resolve(err as Error & { code?: string })) })
    expect(error.code).toBe('EEXIST')
    expect(touched).toEqual([])
  })
})

describe('readdir of an ancestor lists only the next segment toward the files root', () => {
  it.each([['/', 'orivon'], ['/orivon', 'app'], ['/orivon/', 'app']])('%s lists [%s]', async (path, child) => {
    const touched = installUntouchableOrivon()
    const fs = await import('../fs.js')
    await expect(fs.promises.readdir(path)).resolves.toEqual([child])
    expect(fs.readdirSync(path)).toEqual([child])
    const viaCallback = await new Promise<unknown>((resolve, reject) => { fs.readdir(path, (error, names) => (error !== null ? reject(error) : resolve(names))) })
    expect(viaCallback).toEqual([child])
    expect(touched).toEqual([])
  })

  it('answers withFileTypes with a directory entry, and Buffer names for the buffer encoding', async () => {
    installUntouchableOrivon()
    const fs = await import('../fs.js')
    const dirents = await fs.promises.readdir('/', { withFileTypes: true }) as unknown as Array<{ name: string, isDirectory: () => boolean, isFile: () => boolean }>
    expect(dirents.map((entry) => [entry.name, entry.isDirectory(), entry.isFile()])).toEqual([['orivon', true, false]])
    const syncDirents = fs.readdirSync('/orivon', { withFileTypes: true }) as unknown as Array<{ name: string, isDirectory: () => boolean }>
    expect(syncDirents.map((entry) => [entry.name, entry.isDirectory()])).toEqual([['app', true]])
    const names = await fs.promises.readdir('/', { encoding: 'buffer' }) as unknown as Uint8Array[]
    expect(names.map((name) => new TextDecoder().decode(name))).toEqual(['orivon'])
  })

  it('never lists the picked-path namespace, the temp folder, or a real file', async () => {
    installUntouchableOrivon()
    const { promises } = await import('../fs.js')
    expect(await promises.readdir('/orivon')).not.toContain('picked')
    expect(await promises.readdir('/')).toEqual(['orivon'])
  })
})

describe('a walk from "/" that makes the folder it needs reaches the files root and goes no further', () => {
  it('stats and makes each ancestor, then writes only below the root', async () => {
    const written: string[] = []
    ;(globalThis as GlobalWithOrivon).orivon = {
      fs: {
        mkdir: async (path: string) => { written.push(`mkdir ${path}`) },
        stat: async (path: string) => { throw Object.assign(new Error('missing'), { name: 'OrivonError', code: 'notFound', platformCode: 'ENOENT', path }) }
      }
    } as unknown as Orivon
    const { promises } = await import('../fs.js')
    const target = `${VIRTUAL_ROOT}/wiki/tiddlers`
    const parts = target.split('/').slice(1)
    for (let index = 0; index <= parts.length; index += 1) {
      const directory = `/${parts.slice(0, index).join('/')}`
      const isDirectory = await promises.stat(directory).then((stat) => stat.isDirectory(), () => false)
      if (!isDirectory) await promises.mkdir(directory)
    }
    expect(written).toEqual(['mkdir wiki', 'mkdir wiki/tiddlers'])
  })
})

describe('everything else on an ancestor, and every path beside the files root, stays refused', () => {
  const REFUSED = ['/', '/orivon', '/orivon/other', '/orivon/other/deep', '/etc', '/orivon/app/../other']

  it.each(REFUSED)('write calls on %s fail EACCES and never reach orivon.fs', async (path) => {
    const touched = installUntouchableOrivon()
    const fs = await import('../fs.js')
    const { promises } = fs
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ['writeFile', async () => await promises.writeFile(path, 'x')],
      ['appendFile', async () => await promises.appendFile(path, 'x')],
      ['rm', async () => await promises.rm(path, { recursive: true, force: true })],
      ['rmdir', async () => await promises.rmdir(path)],
      ['unlink', async () => await promises.unlink(path)],
      ['rename from', async () => await promises.rename(path, `${VIRTUAL_ROOT}/x`)],
      ['rename to', async () => await promises.rename(`${VIRTUAL_ROOT}/x`, path)],
      ['open', async () => await promises.open(path, 'r')],
      ['open w', async () => await promises.open(path, 'w')],
      ['readFile', async () => await promises.readFile(path)],
      ['mkdtemp', async () => await promises.mkdtemp(`${path === '/' ? '' : path}/t-`)]
    ]
    for (const [name, attempt] of attempts) {
      await expect(attempt(), name).rejects.toMatchObject({ code: 'EACCES' })
    }
    // A copy from an ancestor meets the directory first, as Node's does, so it is refused as one; either way no byte is read.
    await expect(promises.copyFile(path, `${VIRTUAL_ROOT}/x`)).rejects.toMatchObject({ code: expect.stringMatching(/^(EACCES|EISDIR)$/) })
    for (const [name, attempt] of [
      ['writeFileSync', () => fs.writeFileSync(path, 'x')],
      ['rmSync', () => fs.rmSync(path, { recursive: true })],
      ['rmdirSync', () => fs.rmdirSync(path)],
      ['unlinkSync', () => fs.unlinkSync(path)],
      ['renameSync', () => fs.renameSync(path, `${VIRTUAL_ROOT}/x`)],
      ['openSync', () => fs.openSync(path, 'r')],
      ['readFileSync', () => fs.readFileSync(path)]
    ] as Array<[string, () => unknown]>) {
      expect(attempt, name).toThrow(expect.objectContaining({ code: 'EACCES' }))
    }
    expect(touched).toEqual([])
  })

  it.each(['/orivon/other', '/orivon/other/deep', '/etc', '/orivon/app/../other'])('%s is not a directory that exists: stat and mkdir are refused, existsSync is false', async (path) => {
    installUntouchableOrivon()
    const fs = await import('../fs.js')
    await expect(fs.promises.stat(path)).rejects.toMatchObject({ code: 'EACCES' })
    await expect(fs.promises.readdir(path)).rejects.toMatchObject({ code: 'EACCES' })
    await expect(fs.promises.mkdir(path)).rejects.toMatchObject({ code: 'EACCES' })
    await expect(fs.promises.mkdir(path, { recursive: true })).rejects.toMatchObject({ code: 'EACCES' })
    expect(() => fs.statSync(path)).toThrow(expect.objectContaining({ code: 'EACCES' }))
    expect(() => fs.mkdirSync(path, { recursive: true })).toThrow(expect.objectContaining({ code: 'EACCES' }))
    expect(fs.existsSync(path)).toBe(false)
  })

  it('rm of the root itself is still refused (the root is not an ancestor)', async () => {
    installUntouchableOrivon()
    const { promises } = await import('../fs.js')
    await expect(promises.rm(VIRTUAL_ROOT, { recursive: true })).rejects.toMatchObject({ code: 'EACCES' })
  })
})
