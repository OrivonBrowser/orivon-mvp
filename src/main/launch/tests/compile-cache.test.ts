import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMPILE_CACHE_FOLDER, compileCacheFolder, compileCacheFolderRefusal, runsFromChangingPath, settleCompileCacheLater, startCompileCache, trimCompileCache } from '../compile-cache.js'
import type { CompileCacheApi, FolderApi, FolderInfo } from '../compile-cache.js'

const STATUS = { ENABLED: 1, ALREADY_ENABLED: 2, FAILED: 0, DISABLED: 3 }

function fakeApi (result: ReturnType<CompileCacheApi['enable']> | Error): CompileCacheApi & { readonly asked: string[], flushed: number } {
  const api = {
    asked: [] as string[],
    flushed: 0,
    status: STATUS,
    enable: (directory: string) => {
      api.asked.push(directory)
      if (result instanceof Error) throw result
      return result
    },
    flush: () => { api.flushed++ }
  }
  return api
}

describe('compileCacheFolder', () => {
  it('is a named folder in the data directory every profile and private session shares', () => {
    expect(compileCacheFolder(join('home', 'orivon'))).toBe(join('home', 'orivon', COMPILE_CACHE_FOLDER))
    expect(COMPILE_CACHE_FOLDER).toBe('compiled-code-cache')
  })
})

describe('runsFromChangingPath', () => {
  it.each([
    '/tmp/.mount_OrivonAb12Cd/resources/app.asar',
    '/private/var/folders/xy/T/AppTranslocation/0F1E2D3C-AAAA-BBBB-CCCC-123456789ABC/d/Orivon.app/Contents/Resources/app.asar',
    'C:\\tmp\\AppTranslocation\\x'
  ])('is true for %s, where the path is new at every start', (path) => {
    expect(runsFromChangingPath(path)).toBe(true)
  })

  it.each([
    '/opt/Orivon/resources/app.asar',
    '/home/person/.local/share/orivon/squashfs-root/resources/app.asar',
    '/tmp/appimage_extracted_0123456789abcdef/resources/app.asar',
    'C:\\Users\\person\\AppData\\Local\\Programs\\Orivon\\resources\\app.asar',
    '/Applications/Orivon.app/Contents/Resources/app.asar',
    '/home/person/git/orivon'
  ])('is false for %s, which stays the same', (path) => {
    expect(runsFromChangingPath(path)).toBe(false)
  })
})

const OWN_UID = 1000

function folderInfo (overrides: Partial<{ kind: 'directory' | 'link' | 'file', uid: number, mode: number }> = {}): FolderInfo {
  const { kind = 'directory', uid = OWN_UID, mode = 0o040700 } = overrides
  return { isDirectory: () => kind === 'directory', isSymbolicLink: () => kind === 'link', uid, mode }
}

function fakeFolder (info: FolderInfo | Error): FolderApi & { readonly made: string[] } {
  const folder = {
    made: [] as string[],
    make: (directory: string) => { folder.made.push(directory) },
    inspect: () => {
      if (info instanceof Error) throw info
      return info
    }
  }
  return folder
}

describe('compileCacheFolderRefusal', () => {
  it('accepts a real folder of this user that only this user can write', () => {
    expect(compileCacheFolderRefusal(folderInfo(), OWN_UID)).toBeUndefined()
    expect(compileCacheFolderRefusal(folderInfo({ mode: 0o040755 }), OWN_UID)).toBeUndefined()
  })

  it('refuses a link, whatever it points at', () => {
    expect(compileCacheFolderRefusal(folderInfo({ kind: 'link', mode: 0o120777 }), OWN_UID)).toBe('the folder is a link')
  })

  it('refuses something that is not a folder', () => {
    expect(compileCacheFolderRefusal(folderInfo({ kind: 'file', mode: 0o100600 }), OWN_UID)).toBe('the folder is not a directory')
  })

  it('refuses a folder that belongs to another user, even when only its owner can write it', () => {
    expect(compileCacheFolderRefusal(folderInfo({ uid: 0 }), OWN_UID)).toBe('the folder belongs to another user')
  })

  it('refuses when this process cannot say which user it is', () => {
    expect(compileCacheFolderRefusal(folderInfo(), undefined)).toBe('the folder belongs to another user')
  })

  it.each([[0o040770, 'group'], [0o040720, 'group'], [0o040707, 'other'], [0o040702, 'other'], [0o040777, 'group and other']])('refuses a folder with mode %o, writable by %s', (mode) => {
    expect(compileCacheFolderRefusal(folderInfo({ mode }), OWN_UID)).toBe('the folder can be written by its group or by other users')
  })
})

describe('startCompileCache', () => {
  const POSIX = { platform: 'linux' as const, uid: OWN_UID }
  const PROGRAM = '/opt/Orivon/resources/app.asar'

  it.each([[STATUS.ENABLED], [STATUS.ALREADY_ENABLED]])('returns the folder it asked Node for when the status is %i', (status) => {
    const api = fakeApi({ status })
    const folder = fakeFolder(folderInfo())
    const warn = vi.fn()
    expect(startCompileCache('/data/orivon', PROGRAM, { api, folder, warn, ...POSIX })).toBe(join('/data/orivon', COMPILE_CACHE_FOLDER))
    expect(api.asked).toEqual([join('/data/orivon', COMPILE_CACHE_FOLDER)])
    expect(folder.made).toEqual([join('/data/orivon', COMPILE_CACHE_FOLDER)])
    expect(warn).not.toHaveBeenCalled()
  })

  it('returns the folder Node says it writes to when the cache was on already, which is the one to trim', () => {
    const api = fakeApi({ status: STATUS.ALREADY_ENABLED, directory: '/elsewhere/cache' })
    expect(startCompileCache('/data/orivon', PROGRAM, { api, folder: fakeFolder(folderInfo()), warn: vi.fn(), ...POSIX })).toBe('/elsewhere/cache')
  })

  it('says why once and goes on without a cache when Node cannot open it', () => {
    const warn = vi.fn()
    const api = fakeApi({ status: STATUS.FAILED, message: 'Cannot create cache directory: EACCES' })
    expect(startCompileCache('/data/orivon', PROGRAM, { api, folder: fakeFolder(folderInfo()), warn, ...POSIX })).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[orivon] compile cache not used: Cannot create cache directory: EACCES')
  })

  it('names a failure that carries no message too', () => {
    const warn = vi.fn()
    expect(startCompileCache('/data/orivon', PROGRAM, { api: fakeApi({ status: STATUS.FAILED }), folder: fakeFolder(folderInfo()), warn, ...POSIX })).toBeUndefined()
    expect(warn).toHaveBeenCalledWith('[orivon] compile cache not used: it could not be opened')
  })

  it('never lets a throw out: a start goes on', () => {
    const warn = vi.fn()
    expect(startCompileCache('/data/orivon', PROGRAM, { api: fakeApi(new Error('boom')), folder: fakeFolder(folderInfo()), warn, ...POSIX })).toBeUndefined()
    expect(warn).toHaveBeenCalledWith('[orivon] compile cache not used: boom')
  })

  it('says nothing when the person switched it off with NODE_DISABLE_COMPILE_CACHE', () => {
    const warn = vi.fn()
    expect(startCompileCache('/data/orivon', PROGRAM, { api: fakeApi({ status: STATUS.DISABLED }), folder: fakeFolder(folderInfo()), warn, ...POSIX })).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not ask Node at all for a program that runs from a path that changes at every start', () => {
    const api = fakeApi({ status: STATUS.ENABLED })
    const warn = vi.fn()
    expect(startCompileCache('/data/orivon', '/tmp/.mount_OrivonAb12Cd/resources/app.asar', { api, folder: fakeFolder(folderInfo()), warn, ...POSIX })).toBeUndefined()
    expect(api.asked).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a link', folderInfo({ kind: 'link', mode: 0o120777 }), 'the folder is a link'],
    ['a folder of another user', folderInfo({ uid: 0 }), 'the folder belongs to another user'],
    ['a folder its group can write', folderInfo({ mode: 0o040770 }), 'the folder can be written by its group or by other users']
  ])('is not turned on for %s, and says why once', (_name, info, reason) => {
    const api = fakeApi({ status: STATUS.ENABLED })
    const warn = vi.fn()
    expect(startCompileCache('/data/orivon', PROGRAM, { api, folder: fakeFolder(info), warn, ...POSIX })).toBeUndefined()
    expect(api.asked).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(`[orivon] compile cache not used: ${reason}`)
  })

  it('is not turned on when the folder cannot be made or read, and says why', () => {
    const api = fakeApi({ status: STATUS.ENABLED })
    const warn = vi.fn()
    expect(startCompileCache('/data/orivon', PROGRAM, { api, folder: fakeFolder(new Error('ENOENT: no such file or directory')), warn, ...POSIX })).toBeUndefined()
    expect(api.asked).toEqual([])
    expect(warn).toHaveBeenCalledWith('[orivon] compile cache not used: ENOENT: no such file or directory')
  })

  it('makes and checks nothing on Windows, where the folder sits under the user\'s own profile', () => {
    const api = fakeApi({ status: STATUS.ENABLED })
    const folder = fakeFolder(new Error('must not be read'))
    expect(startCompileCache('C:\\Users\\person\\AppData\\Roaming\\Orivon', 'C:\\Program Files\\Orivon\\resources\\app.asar', { api, folder, warn: vi.fn(), platform: 'win32', uid: undefined })).toBe(join('C:\\Users\\person\\AppData\\Roaming\\Orivon', COMPILE_CACHE_FOLDER))
    expect(folder.made).toEqual([])
  })
})

describe.skipIf(process.platform === 'win32')('startCompileCache against the real file system', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'orivon-compile-cache-home-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  const run = (): { readonly result: string | undefined, readonly warn: ReturnType<typeof vi.fn>, readonly api: ReturnType<typeof fakeApi> } => {
    const api = fakeApi({ status: STATUS.ENABLED })
    const warn = vi.fn()
    return { result: startCompileCache(home, '/opt/Orivon/resources/app.asar', { api, warn }), warn, api }
  }

  it('makes the folder for this user alone and turns the cache on', () => {
    const { result, warn, api } = run()
    const folder = join(home, COMPILE_CACHE_FOLDER)
    expect(result).toBe(folder)
    expect(statSync(folder).mode & 0o077).toBe(0)
    expect(api.asked).toEqual([folder])
    expect(warn).not.toHaveBeenCalled()
  })

  it('uses a folder it made at an earlier start', () => {
    run()
    expect(run().result).toBe(join(home, COMPILE_CACHE_FOLDER))
  })

  it('refuses a folder its group can write', () => {
    const folder = join(home, COMPILE_CACHE_FOLDER)
    mkdirSync(folder)
    chmodSync(folder, 0o770)
    const { result, warn, api } = run()
    expect(result).toBeUndefined()
    expect(api.asked).toEqual([])
    expect(warn).toHaveBeenCalledWith('[orivon] compile cache not used: the folder can be written by its group or by other users')
  })

  it('refuses a link to a folder, which could be anyone\'s', () => {
    const elsewhere = join(home, 'elsewhere')
    mkdirSync(elsewhere, { mode: 0o700 })
    symlinkSync(elsewhere, join(home, COMPILE_CACHE_FOLDER))
    const { result, warn, api } = run()
    expect(result).toBeUndefined()
    expect(api.asked).toEqual([])
    expect(warn).toHaveBeenCalledWith('[orivon] compile cache not used: the folder is a link')
  })
})

describe('trimCompileCache', () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orivon-compile-cache-trim-'))
    mkdirSync(join(directory, 'v24-x64'))
  })
  afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

  function entry (name: string, bytes: number, ageSeconds: number): string {
    const path = join(directory, 'v24-x64', name)
    writeFileSync(path, Buffer.alloc(bytes))
    const when = new Date(Date.now() - ageSeconds * 1000)
    utimesSync(path, when, when)
    return path
  }

  it('leaves a folder that is within its limit alone', async () => {
    const first = entry('a', 400, 30)
    const second = entry('b', 400, 10)
    await trimCompileCache(directory, 1000)
    expect(existsSync(first)).toBe(true)
    expect(existsSync(second)).toBe(true)
  })

  it('removes the oldest entries down to half the limit and keeps the newest', async () => {
    const oldest = entry('a', 400, 300)
    const older = entry('b', 400, 200)
    const newer = entry('c', 400, 100)
    const newest = entry('d', 400, 5)
    await trimCompileCache(directory, 1000)
    expect(existsSync(oldest)).toBe(false)
    expect(existsSync(older)).toBe(false)
    expect(existsSync(newer)).toBe(false)
    expect(existsSync(newest)).toBe(true)
  })

  it('is not an error when there is no folder', async () => {
    await expect(trimCompileCache(join(directory, 'missing'), 10)).resolves.toBeUndefined()
  })
})

describe('settleCompileCacheLater', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('writes the cache out once, after the delay and not before', () => {
    const api = fakeApi({ status: STATUS.ENABLED })
    settleCompileCacheLater(join(tmpdir(), 'orivon-compile-cache-never-made'), 15_000, api)
    vi.advanceTimersByTime(14_999)
    expect(api.flushed).toBe(0)
    vi.advanceTimersByTime(1)
    expect(api.flushed).toBe(1)
    vi.advanceTimersByTime(60_000)
    expect(api.flushed).toBe(1)
  })

  it('lets no throw out of a flush that fails', () => {
    const api = { ...fakeApi({ status: STATUS.ENABLED }), flush: () => { throw new Error('disk full') } }
    settleCompileCacheLater(join(tmpdir(), 'orivon-compile-cache-never-made'), 1, api)
    expect(() => { vi.advanceTimersByTime(1) }).not.toThrow()
  })
})
