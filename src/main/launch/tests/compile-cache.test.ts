import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMPILE_CACHE_FOLDER, compileCacheFolder, runsFromChangingPath, settleCompileCacheLater, startCompileCache, trimCompileCache } from '../compile-cache.js'
import type { CompileCacheApi } from '../compile-cache.js'

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

describe('startCompileCache', () => {
  it.each([[STATUS.ENABLED], [STATUS.ALREADY_ENABLED]])('returns the folder it asked Node for when the status is %i', (status) => {
    const api = fakeApi({ status })
    const warn = vi.fn()
    expect(startCompileCache('/data/orivon', '/opt/Orivon/resources/app.asar', api, warn)).toBe(join('/data/orivon', COMPILE_CACHE_FOLDER))
    expect(api.asked).toEqual([join('/data/orivon', COMPILE_CACHE_FOLDER)])
    expect(warn).not.toHaveBeenCalled()
  })

  it('returns the folder Node says it writes to when the cache was on already, which is the one to trim', () => {
    const api = fakeApi({ status: STATUS.ALREADY_ENABLED, directory: '/elsewhere/cache' })
    expect(startCompileCache('/data/orivon', '/opt/Orivon/resources/app.asar', api, vi.fn())).toBe('/elsewhere/cache')
  })

  it('says why once and goes on without a cache when Node cannot open it', () => {
    const warn = vi.fn()
    expect(startCompileCache('/data/orivon', '/opt/Orivon/resources/app.asar', fakeApi({ status: STATUS.FAILED, message: 'Cannot create cache directory: EACCES' }), warn)).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[orivon] compile cache not used: Cannot create cache directory: EACCES')
  })

  it('names a failure that carries no message too', () => {
    const warn = vi.fn()
    expect(startCompileCache('/data/orivon', '/opt/Orivon/resources/app.asar', fakeApi({ status: STATUS.FAILED }), warn)).toBeUndefined()
    expect(warn).toHaveBeenCalledWith('[orivon] compile cache not used: it could not be opened')
  })

  it('never lets a throw out: a start goes on', () => {
    const warn = vi.fn()
    expect(startCompileCache('/data/orivon', '/opt/Orivon/resources/app.asar', fakeApi(new Error('boom')), warn)).toBeUndefined()
    expect(warn).toHaveBeenCalledWith('[orivon] compile cache not used: boom')
  })

  it('says nothing when the person switched it off with NODE_DISABLE_COMPILE_CACHE', () => {
    const warn = vi.fn()
    expect(startCompileCache('/data/orivon', '/opt/Orivon/resources/app.asar', fakeApi({ status: STATUS.DISABLED }), warn)).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not ask Node at all for a program that runs from a path that changes at every start', () => {
    const api = fakeApi({ status: STATUS.ENABLED })
    const warn = vi.fn()
    expect(startCompileCache('/data/orivon', '/tmp/.mount_OrivonAb12Cd/resources/app.asar', api, warn)).toBeUndefined()
    expect(api.asked).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
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
