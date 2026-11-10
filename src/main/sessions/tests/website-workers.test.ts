import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onAppOriginRetired, registerAppOrigin, retireAppOrigin } from '../../../loader/electron/app-partitions.js'
import type { Session } from 'electron'
import { CLEARED_MARKS_DIRECTORY, LEGACY_CLEARED_MARKS_DIRECTORY, clearedOriginsIn, clearedOriginsInMemory, forgetWebsiteWorkers, prepareWebsiteWorkers } from '../website-workers.js'

describe('forgetWebsiteWorkers', () => {
  it("drops the origin's service workers and Cache Storage, and nothing else of the session", async () => {
    const cleared: Array<{ origin: string, storages: string[] }> = []
    await forgetWebsiteWorkers({ clearStorageData: async (options) => { cleared.push(options) } }, 'https://app.ipfs.orivon')
    expect(cleared).toEqual([{ origin: 'https://app.ipfs.orivon', storages: ['serviceworkers', 'cachestorage'] }])
  })

  it('lets a failure to clear reach the caller, so the app is not served around a worker it could not drop', async () => {
    await expect(forgetWebsiteWorkers({ clearStorageData: async () => { throw new Error('storage busy') } }, 'https://app.ipfs.orivon')).rejects.toThrow('storage busy')
  })
})

describe('prepareWebsiteWorkers', () => {
  const ORIGIN = 'https://app.ipfs.orivon'
  const recorder = (): { cleared: string[], storage: { clearStorageData: (options: { origin: string, storages: Array<'serviceworkers' | 'cachestorage'> }) => Promise<void> } } => {
    const cleared: string[] = []
    return { cleared, storage: { clearStorageData: async (options) => { cleared.push(options.origin) } } }
  }

  it('clears each time an app is served live, since it was a website a moment ago', async () => {
    const { cleared, storage } = recorder()
    const marks = clearedOriginsInMemory()
    await prepareWebsiteWorkers([storage], ORIGIN, 'verifier', marks)
    await prepareWebsiteWorkers([storage], ORIGIN, 'verifier', marks)
    expect(cleared).toEqual([ORIGIN, ORIGIN])
  })

  it('clears an app served from its pin once, for one that moved to the shared session with a website\'s workers in it, and then leaves its own', async () => {
    const { cleared, storage } = recorder()
    const marks = clearedOriginsInMemory()
    await prepareWebsiteWorkers([storage], ORIGIN, 'pin', marks)
    await prepareWebsiteWorkers([storage], ORIGIN, 'pin', marks)
    expect(cleared).toEqual([ORIGIN])
  })

  it('does not clear again from the pin after the live serving did', async () => {
    const { cleared, storage } = recorder()
    const marks = clearedOriginsInMemory()
    await prepareWebsiteWorkers([storage], ORIGIN, 'verifier', marks)
    await prepareWebsiteWorkers([storage], ORIGIN, 'pin', marks)
    expect(cleared).toEqual([ORIGIN])
  })

  it('does not mark an origin whose clearing failed, so the next start tries again', async () => {
    const marks = clearedOriginsInMemory()
    await expect(prepareWebsiteWorkers([{ clearStorageData: async () => { throw new Error('storage busy') } }], ORIGIN, 'pin', marks)).rejects.toThrow('storage busy')
    expect(marks.has(ORIGIN)).toBe(false)
  })

  it('clears the origin in every session the website may have run in, not only the first', async () => {
    const first = recorder()
    const second = recorder()
    await prepareWebsiteWorkers([first.storage, second.storage], ORIGIN, 'pin', clearedOriginsInMemory())
    expect(first.cleared).toEqual([ORIGIN])
    expect(second.cleared).toEqual([ORIGIN])
  })

  it('clears again from the pin once the origin stopped being served, since a website may have registered a worker meanwhile', async () => {
    const { cleared, storage } = recorder()
    const marks = clearedOriginsInMemory()
    await prepareWebsiteWorkers([storage], ORIGIN, 'pin', marks)
    marks.forget(ORIGIN)
    await prepareWebsiteWorkers([storage], ORIGIN, 'pin', marks)
    expect(cleared).toEqual([ORIGIN, ORIGIN])
  })

  it('clears a website\'s worker again when the pin lands after the app was retired, which is how a block ends the app', async () => {
    const protocol = { isProtocolHandled: () => false, unhandle: () => {}, handle: () => {} }
    const appSession = { protocol } as unknown as Session
    const { cleared, storage } = recorder()
    const marks = clearedOriginsInMemory()
    const stop = onAppOriginRetired((origin) => { marks.forget(origin) })
    try {
      registerAppOrigin(appSession, ORIGIN, async () => new Response('app'), 'verifier')
      await prepareWebsiteWorkers([storage], ORIGIN, 'verifier', marks)
      retireAppOrigin(appSession, ORIGIN)
      await prepareWebsiteWorkers([storage], ORIGIN, 'pin', marks)
      expect(cleared).toEqual([ORIGIN, ORIGIN])
    } finally {
      stop()
    }
  })

  it('forgets an origin in files too, and only that one', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orivon-cleared-'))
    try {
      const marks = clearedOriginsIn(directory)
      marks.add(ORIGIN)
      marks.add('https://other.ipfs.orivon')
      marks.forget(ORIGIN)
      marks.forget('https://never.ipfs.orivon')
      expect(clearedOriginsIn(directory).has(ORIGIN)).toBe(false)
      expect(clearedOriginsIn(directory).has('https://other.ipfs.orivon')).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('remembers the origins it cleared across a restart in files, one per origin', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orivon-cleared-'))
    try {
      const { cleared, storage } = recorder()
      await prepareWebsiteWorkers([storage], ORIGIN, 'pin', clearedOriginsIn(directory))
      await prepareWebsiteWorkers([storage], ORIGIN, 'pin', clearedOriginsIn(directory))
      expect(cleared).toEqual([ORIGIN])
      expect(clearedOriginsIn(directory).has('https://other.ipfs.orivon')).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('the marks that say a website\'s workers were cleared', () => {
  const ORIGIN = 'https://app.ipfs.orivon'

  it('live in a directory of their own, so a mark an earlier build wrote does not stand for the guard this build arms', async () => {
    const base = mkdtempSync(join(tmpdir(), 'orivon-marks-'))
    try {
      expect(CLEARED_MARKS_DIRECTORY).not.toBe(LEGACY_CLEARED_MARKS_DIRECTORY)
      mkdirSync(join(base, LEGACY_CLEARED_MARKS_DIRECTORY), { recursive: true })
      clearedOriginsIn(join(base, LEGACY_CLEARED_MARKS_DIRECTORY)).add(ORIGIN)
      const marks = clearedOriginsIn(join(base, CLEARED_MARKS_DIRECTORY))
      expect(marks.has(ORIGIN)).toBe(false)
      const cleared: string[] = []
      await prepareWebsiteWorkers([{ clearStorageData: async (options) => { cleared.push(options.origin) } }], ORIGIN, 'pin', marks)
      expect(cleared).toEqual([ORIGIN])
      expect(clearedOriginsIn(join(base, CLEARED_MARKS_DIRECTORY)).has(ORIGIN)).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
