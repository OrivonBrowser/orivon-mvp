import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearedOriginsIn, clearedOriginsInMemory, forgetWebsiteWorkers, prepareWebsiteWorkers } from '../website-workers.js'

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
    await prepareWebsiteWorkers(storage, ORIGIN, 'verifier', marks)
    await prepareWebsiteWorkers(storage, ORIGIN, 'verifier', marks)
    expect(cleared).toEqual([ORIGIN, ORIGIN])
  })

  it('clears an app served from its pin once, for one that moved to the shared session with a website\'s workers in it, and then leaves its own', async () => {
    const { cleared, storage } = recorder()
    const marks = clearedOriginsInMemory()
    await prepareWebsiteWorkers(storage, ORIGIN, 'pin', marks)
    await prepareWebsiteWorkers(storage, ORIGIN, 'pin', marks)
    expect(cleared).toEqual([ORIGIN])
  })

  it('does not clear again from the pin after the live serving did', async () => {
    const { cleared, storage } = recorder()
    const marks = clearedOriginsInMemory()
    await prepareWebsiteWorkers(storage, ORIGIN, 'verifier', marks)
    await prepareWebsiteWorkers(storage, ORIGIN, 'pin', marks)
    expect(cleared).toEqual([ORIGIN])
  })

  it('does not mark an origin whose clearing failed, so the next start tries again', async () => {
    const marks = clearedOriginsInMemory()
    await expect(prepareWebsiteWorkers({ clearStorageData: async () => { throw new Error('storage busy') } }, ORIGIN, 'pin', marks)).rejects.toThrow('storage busy')
    expect(marks.has(ORIGIN)).toBe(false)
  })

  it('remembers the origins it cleared across a restart in files, one per origin', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orivon-cleared-'))
    try {
      const { cleared, storage } = recorder()
      await prepareWebsiteWorkers(storage, ORIGIN, 'pin', clearedOriginsIn(directory))
      await prepareWebsiteWorkers(storage, ORIGIN, 'pin', clearedOriginsIn(directory))
      expect(cleared).toEqual([ORIGIN])
      expect(clearedOriginsIn(directory).has('https://other.ipfs.orivon')).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
