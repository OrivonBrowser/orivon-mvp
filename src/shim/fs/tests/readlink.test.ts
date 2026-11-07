// readlink, readlinkSync and fs.promises.readlink answer as Node does on a disk with no links: orivon.fs has no
// symbolic links, so a path that exists is not a link (EINVAL) and one that does not is ENOENT, in the callback,
// promise and synchronous forms alike. The case that matters: a write helper's
// `realpath(p)`, then `readlink(p).catch(() => null)` for a file that is not there yet, must see a rejection.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Orivon } from '../../../contracts/capability-api.js'
import { createFakeDirectoryHandle } from '../../tests/support/fake-directory-handle.js'
import { createFakeFileHandle } from '../../tests/support/fake-file-handle.js'
import { VIRTUAL_ROOT } from '../../virtual-root.js'

const SYNCHRONOUS = Symbol.for('orivon.synchronous')

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }
type Coded = Error & { code?: string, errno?: number, syscall?: string, path?: string }

function orivonError (code: string, platformCode?: string): Error {
  return Object.assign(new Error(`${code} failure`), { name: 'OrivonError', code, ...(platformCode === undefined ? {} : { platformCode }) })
}

/** An orivon whose `stat` knows `present` (a path ending in `.json` is a file, any other a directory), on the page and on the synchronous twin. */
function install (present: readonly string[] = ['users', 'users/a.json'], failWith?: Error): string[] {
  const asked: string[] = []
  const stat = (path: string) => {
    asked.push(path)
    if (failWith !== undefined) throw failWith
    if (!present.includes(path)) throw orivonError('notFound', 'ENOENT')
    return { size: 0, isFile: path.endsWith('.json'), isDirectory: !path.endsWith('.json'), mtimeMs: 0 }
  }
  const members = { stat: async (path: string) => stat(path) }
  ;(globalThis as GlobalWithOrivon).orivon = {
    fs: members,
    [SYNCHRONOUS]: { fs: { stat } }
  } as unknown as Orivon
  return asked
}

/** An orivon any member of which fails the test: for paths that must be answered without asking the broker. */
function installUntouchable (): string[] {
  const touched: string[] = []
  const members = new Proxy({}, {
    get: (_target, member) => (...args: unknown[]) => { touched.push(`${String(member)}(${String(args[0])})`); throw new Error(`orivon.fs.${String(member)} must not be reached`) }
  })
  ;(globalThis as GlobalWithOrivon).orivon = { fs: members, [SYNCHRONOUS]: { fs: members } } as unknown as Orivon
  return touched
}

afterEach(() => {
  delete (globalThis as GlobalWithOrivon).orivon
  vi.resetModules()
})

/** What each of the three forms did with `path`, so one assertion can hold them to the same answer. */
async function allForms (fs: typeof import('../fs.js'), path: string, options?: unknown): Promise<{ callback: Coded, promise: Coded, sync: Coded }> {
  const callback = await new Promise<Coded>((resolve) => {
    const done = (error: Error | null, target?: unknown): void => resolve(error ?? new Error(`resolved with ${String(target)}`))
    if (options === undefined) fs.readlink(path, done)
    else fs.readlink(path, options as never, done)
  })
  const promise = await fs.promises.readlink(path, options as never).then((target) => new Error(`resolved with ${String(target)}`), (error: Coded) => error)
  const sync = (() => {
    try { return new Error(`returned ${String(fs.readlinkSync(path, options as never))}`) } catch (error) { return error as Coded }
  })()
  return { callback, promise, sync }
}

describe('readlink on the app\'s files: nothing is a link', () => {
  it('a missing path is ENOENT in Node\'s error shape, in every form', async () => {
    install()
    const fs = await import('../fs.js')
    const forms = await allForms(fs, 'users/new.json')
    for (const error of Object.values(forms)) {
      expect(error).toMatchObject({ code: 'ENOENT', errno: -2, syscall: 'readlink', path: 'users/new.json' })
      expect(error.message).toBe("ENOENT: no such file or directory, readlink 'users/new.json'")
    }
  })

  it('an existing file is EINVAL, in every form', async () => {
    install()
    const fs = await import('../fs.js')
    for (const error of Object.values(await allForms(fs, 'users/a.json'))) {
      expect(error).toMatchObject({ code: 'EINVAL', errno: -22, syscall: 'readlink', path: 'users/a.json' })
      expect(error.message).toBe("EINVAL: invalid argument, readlink 'users/a.json'")
    }
  })

  it('an existing directory is EINVAL, in every form', async () => {
    install()
    const fs = await import('../fs.js')
    for (const error of Object.values(await allForms(fs, 'users'))) {
      expect(error).toMatchObject({ code: 'EINVAL', syscall: 'readlink', path: 'users' })
    }
  })

  it('an absolute path under the virtual root reaches the broker as the confined path, and the error names the path as written', async () => {
    const asked = install()
    const fs = await import('../fs.js')
    const forms = await allForms(fs, `${VIRTUAL_ROOT}/users/a.json`)
    for (const error of Object.values(forms)) expect(error).toMatchObject({ code: 'EINVAL', path: `${VIRTUAL_ROOT}/users/a.json` })
    expect(new Set(asked)).toEqual(new Set(['users/a.json']))
  })

  it('the root itself exists and is not a link, answered without the broker', async () => {
    const touched = installUntouchable()
    const fs = await import('../fs.js')
    for (const error of Object.values(await allForms(fs, VIRTUAL_ROOT))) expect(error).toMatchObject({ code: 'EINVAL', syscall: 'readlink' })
    expect(touched).toEqual([])
  })

  it('takes a Buffer or a file: URL for the path, as Node does', async () => {
    install()
    const fs = await import('../fs.js')
    await expect(fs.promises.readlink(new TextEncoder().encode('users/a.json'))).rejects.toMatchObject({ code: 'EINVAL' })
    expect(() => fs.readlinkSync(new URL(`file://${VIRTUAL_ROOT}/users/new.json`))).toThrow(expect.objectContaining({ code: 'ENOENT' }) as Error)
  })

  it('options are accepted for the signature and change nothing: a string, an object, a buffer encoding, null', async () => {
    install()
    const fs = await import('../fs.js')
    for (const options of ['utf8', 'buffer', { encoding: 'utf8' }, { encoding: 'buffer' }, { encoding: null }, null]) {
      const present = await allForms(fs, 'users/a.json', options)
      const absent = await allForms(fs, 'users/new.json', options)
      expect(Object.values(present).map((error) => error.code)).toEqual(['EINVAL', 'EINVAL', 'EINVAL'])
      expect(Object.values(absent).map((error) => error.code)).toEqual(['ENOENT', 'ENOENT', 'ENOENT'])
    }
  })
})

describe('the async forms never throw synchronously', () => {
  it('fs.promises.readlink returns a rejected promise, so a .catch on it sees the error', async () => {
    install()
    const { promises } = await import('../fs.js')
    let returned: Promise<unknown> | undefined
    expect(() => { returned = promises.readlink('users/new.json') }).not.toThrow()
    expect(returned).toBeInstanceOf(Promise)
    await expect(returned).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('the atomic-write helper\'s probe works: realpath of a new file fails ENOENT, then readlink(...).catch gives null', async () => {
    install()
    const { promises } = await import('../fs.js')
    const target = 'users/new.json'
    const real = await promises.realpath(target).catch((error: Coded) => { if (error.code !== 'ENOENT') throw error; return undefined })
    expect(real).toBeUndefined()
    const link = await promises.readlink(target).catch(() => null)
    expect(link).toBeNull()
  })

  it('a path of the wrong type rejects (promise) or calls back (callback), and throws only from the synchronous form', async () => {
    install()
    const fs = await import('../fs.js')
    await expect(fs.promises.readlink(42 as never)).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_TYPE' })
    const error = await new Promise<Coded>((resolve) => { fs.readlink(42 as never, resolve as never) })
    expect(error.code).toBe('ERR_INVALID_ARG_TYPE')
    expect(() => fs.readlinkSync(42 as never)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }) as Error)
  })

  it('the callback form without a callback is Node\'s ERR_INVALID_ARG_TYPE for `cb`', async () => {
    install()
    const fs = await import('../fs.js')
    expect(() => (fs.readlink as (...args: unknown[]) => void)('users')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }) as Error)
    expect(() => (fs.readlink as (...args: unknown[]) => void)('users', 'utf8')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }) as Error)
  })

  it('calls the callback once, with the error and no value', async () => {
    install()
    const fs = await import('../fs.js')
    const calls: unknown[][] = []
    await new Promise<void>((resolve) => { fs.readlink('users/a.json', (...args: unknown[]) => { calls.push(args); resolve() }) })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(1)
  })
})

describe('what is not an answer about existence passes through as it does for stat', () => {
  it('a denial from the broker stays \'denied\', never ENOENT or EINVAL', async () => {
    install([], orivonError('denied'))
    const fs = await import('../fs.js')
    for (const error of Object.values(await allForms(fs, 'users/a.json'))) expect(error.code).toBe('denied')
  })

  it('a path the app may not reach is the same EACCES from all three forms, naming readlink, without asking the broker', async () => {
    const asked = install()
    const fs = await import('../fs.js')
    for (const outside of ['/etc/passwd', '../escape', '/orivon/other', '/orivon/app/../../etc']) {
      const forms = await allForms(fs, outside)
      for (const error of Object.values(forms)) expect(error).toMatchObject({ code: 'EACCES', errno: -13, syscall: 'readlink', path: outside })
      expect(forms.callback.message).toBe(forms.sync.message)
      expect(forms.promise.message).toBe(forms.sync.message)
    }
    expect(asked).toEqual([])
  })
})

describe('the directories above the app\'s files', () => {
  it.each(['/', '/orivon', '/orivon/'])('%s exists and is not a link: EINVAL in every form, answered without the broker', async (path) => {
    const touched = installUntouchable()
    const fs = await import('../fs.js')
    for (const error of Object.values(await allForms(fs, path))) expect(error).toMatchObject({ code: 'EINVAL', syscall: 'readlink', path })
    expect(touched).toEqual([])
  })

  it('a path beside the root stays EACCES, as for every other call', async () => {
    installUntouchable()
    const fs = await import('../fs.js')
    for (const error of Object.values(await allForms(fs, '/orivon/other'))) expect(error.code).toBe('EACCES')
  })
})

describe('a picked path', () => {
  async function load () {
    const registry = await import('../../../shim-electron/picked-paths.js')
    const fs = await import('../fs.js')
    return { ...registry, fs }
  }

  function pickedFile (text: string) {
    return createFakeFileHandle(new TextEncoder().encode(text)).handle
  }

  it('a picked file, and the stand-in folder around it, exist and are not links', async () => {
    install()
    const { registerPickedFile, fs } = await load()
    const file = registerPickedFile(pickedFile('x'), 'note.txt')
    const folder = file.slice(0, file.lastIndexOf('/'))
    for (const path of [file, folder]) {
      for (const error of Object.values(await allForms(fs, path))) expect(error).toMatchObject({ code: 'EINVAL', syscall: 'readlink', path })
    }
  })

  it('another name in a picked file\'s folder is ENOENT in every form, and the error carries the stand-in path only', async () => {
    install()
    const { registerPickedFile, fs } = await load()
    const file = registerPickedFile(pickedFile('x'), 'note.txt')
    const other = `${file.slice(0, file.lastIndexOf('/'))}/other.txt`
    for (const error of Object.values(await allForms(fs, other))) {
      expect(error).toMatchObject({ code: 'ENOENT', syscall: 'readlink', path: other })
      expect(error.message).toBe(`ENOENT: no such file or directory, readlink '${other}'`)
    }
  })

  it('a picked folder: its root and an existing entry are EINVAL, a missing entry ENOENT (asynchronous forms)', async () => {
    install()
    const { registerPickedDirectory, fs } = await load()
    const directory = createFakeDirectoryHandle()
    directory.put('inside.txt', 'x')
    const folder = registerPickedDirectory(directory.handle)
    for (const path of [folder, `${folder}/inside.txt`]) {
      const callback = await new Promise<Coded>((resolve) => { fs.readlink(path, resolve as never) })
      const promise = await fs.promises.readlink(path).catch((error: Coded) => error)
      for (const error of [callback, promise]) expect(error).toMatchObject({ code: 'EINVAL', syscall: 'readlink', path })
    }
    const missing = `${folder}/missing.txt`
    const callback = await new Promise<Coded>((resolve) => { fs.readlink(missing, resolve as never) })
    const promise = await fs.promises.readlink(missing).catch((error: Coded) => error)
    for (const error of [callback, promise]) expect(error).toMatchObject({ code: 'ENOENT', syscall: 'readlink', path: missing })
  })

  it('a pick that did not survive a reload is ENOENT and says to pick again', async () => {
    install()
    const { fs } = await load()
    const stale = '/orivon/picked/aaaaaaaaaaaaaaaaaaaaaaaa/a.txt'
    const forms = await allForms(fs, stale)
    for (const error of [forms.callback, forms.promise]) expect(error).toMatchObject({ code: 'ENOENT', syscall: 'readlink', path: stale })
    expect(forms.promise.message).toMatch(/pick it again/)
    expect(forms.sync).toMatchObject({ code: 'ENOENT', syscall: 'readlink', path: stale })
  })

  it('the synchronous form answers what the table in memory knows and is ENOSYS, like every *Sync call, for what only a wire could tell', async () => {
    install()
    const { registerPickedFile, registerPickedDirectory, fs } = await load()
    const file = registerPickedFile(pickedFile('x'), 'note.txt')
    const folder = registerPickedDirectory(createFakeDirectoryHandle().handle)
    const folderOfFile = file.slice(0, file.lastIndexOf('/'))
    const code = (path: string): string | undefined => { try { fs.readlinkSync(path) } catch (error) { return (error as Coded).code } return undefined }
    expect(code(file)).toBe('EINVAL')
    expect(code(folderOfFile)).toBe('EINVAL')
    expect(code(folder)).toBe('EINVAL')
    expect(code(`${folderOfFile}/other.txt`)).toBe('ENOENT')
    expect(code(`${folder}/inside.txt`)).toBe('ENOSYS')
    expect(code('/orivon/picked')).toBe('ENOSYS')
  })

  it('never reaches the broker, and no host path is in any error', async () => {
    const touched = installUntouchable()
    const { registerPickedFile, fs } = await load()
    const file = registerPickedFile(pickedFile('x'), 'note.txt')
    const errors = Object.values(await allForms(fs, file))
    expect(errors.map((error) => error.code)).toEqual(['EINVAL', 'EINVAL', 'EINVAL'])
    expect(touched).toEqual([])
  })
})

describe('the members exist', () => {
  it('are real functions on fs, its default export, fs.promises and the fs/promises module, not refusals', async () => {
    install()
    const fs = await import('../fs.js')
    const promisesModule = await import('../promises.js')
    expect(typeof fs.readlink).toBe('function')
    expect(typeof fs.readlinkSync).toBe('function')
    expect(typeof fs.promises.readlink).toBe('function')
    expect(typeof (fs.default as unknown as { readlink: unknown }).readlink).toBe('function')
    expect(typeof (fs.default as unknown as { readlinkSync: unknown }).readlinkSync).toBe('function')
    expect(promisesModule.readlink).toBe(fs.promises.readlink)
    expect(promisesModule.default.readlink).toBe(fs.promises.readlink)
  })
})
