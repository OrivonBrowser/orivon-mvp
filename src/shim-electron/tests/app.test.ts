import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { ElectronShimError } from '../errors.js'
import type { Manifest } from '../../contracts/manifest.js'
import type { Orivon } from '../../contracts/capability-api.js'

const MANIFEST: Manifest = {
  orivonApiVersion: 0,
  id: 'com.example.app',
  name: 'Example App',
  version: '1.2.3',
  entry: 'index.html',
  capabilities: {}
}

/** Only the slice of `Orivon` app.ts reads -- see app.ts's own `Pick`. */
function fakeOrivon (manifest: Manifest = MANIFEST): Pick<Orivon, 'app'> {
  return { app: { manifest: vi.fn(async () => manifest), grants: vi.fn(async () => []), requestGrant: vi.fn(async () => false) } }
}

describe('createApp', () => {
  it('throws a named error if getVersion is called before whenReady resolves', () => {
    const app = createApp(fakeOrivon())
    expect(() => app.getVersion()).toThrow(ElectronShimError)
    try {
      app.getVersion()
    } catch (error) {
      expect((error as ElectronShimError).reason).toBe('not-ready')
    }
  })

  it('throws a named error if getPath is called before whenReady resolves', () => {
    const app = createApp(fakeOrivon())
    expect(() => app.getPath('userData')).toThrow(ElectronShimError)
  })

  it('reports isReady() as false until whenReady resolves', async () => {
    const app = createApp(fakeOrivon())
    expect(app.isReady()).toBe(false)
    await app.whenReady()
    expect(app.isReady()).toBe(true)
  })

  it('serves getVersion() from the manifest fetched by whenReady()', async () => {
    const app = createApp(fakeOrivon())
    await app.whenReady()
    expect(app.getVersion()).toBe('1.2.3')
  })

  it('serves getPath("userData") as a value safe to join with a relative orivon.fs path', async () => {
    const app = createApp(fakeOrivon())
    await app.whenReady()
    const userData = app.getPath('userData')
    expect(typeof userData).toBe('string')
    expect(userData.startsWith('/')).toBe(false)
  })

  it('refuses any getPath name other than userData, naming the ambient-fs reason', async () => {
    const app = createApp(fakeOrivon())
    await app.whenReady()
    expect(() => app.getPath('home')).toThrow(ElectronShimError)
    try {
      app.getPath('exe')
    } catch (error) {
      expect((error as ElectronShimError).reason).toBe('ambient-fs')
    }
  })

  it('fetches the manifest only once even when whenReady is called twice concurrently', async () => {
    const orivon = fakeOrivon()
    const app = createApp(orivon)
    await Promise.all([app.whenReady(), app.whenReady()])
    expect(orivon.app.manifest).toHaveBeenCalledTimes(1)
  })

  it('resolves the same whenReady() promise on a later call, after the first has already resolved', async () => {
    const app = createApp(fakeOrivon())
    await app.whenReady()
    await expect(app.whenReady()).resolves.toBeUndefined()
  })
})
