import { describe, expect, it } from 'vitest'
import { forgetWebsiteWorkers } from '../website-workers.js'

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
