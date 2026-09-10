import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Manifest } from '../../contracts/manifest.js'
import type { Orivon } from '../../contracts/capability-api.js'

const MANIFEST: Manifest = {
  orivonApiVersion: 0,
  id: 'com.example.app',
  name: 'Example App',
  version: '0.0.1',
  entry: 'index.html',
  capabilities: {}
}

/** A full Orivon fake -- index.ts wires the real global, so this test exercises that wiring, not a Pick<>. */
function fakeOrivon (): Orivon {
  const unused = async (): Promise<never> => { throw new Error('unused in this test') }
  const unusedSync = (): never => { throw new Error('unused in this test') }
  return {
    version: 0,
    app: { manifest: async () => MANIFEST, grants: async () => [], requestGrant: async () => false },
    net: { connect: unused, connectSecure: unused, listen: unused, udpBind: unused },
    fs: {
      readFile: async () => new Uint8Array(),
      writeFile: async () => {},
      readFileSync: unusedSync,
      open: unused,
      mkdir: async () => {},
      readdir: async () => [],
      stat: unused,
      rm: async () => {},
      rename: async () => {},
      userSelected: async () => []
    },
    id: { publicKey: async () => new Uint8Array(), sign: async () => new Uint8Array(), requestIdentity: async () => null }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('the electron module entry point', () => {
  it('throws naming window.orivon when imported outside an Orivon app', async () => {
    vi.stubGlobal('orivon', undefined)
    await expect(import('../index.js')).rejects.toThrow(/window\.orivon/)
  })

  it('resolves and exposes the whole surface when orivon is present', async () => {
    vi.stubGlobal('orivon', fakeOrivon())
    const mod = await import('../index.js')

    expect(typeof mod.app.getVersion).toBe('function')
    expect(typeof mod.dialog.showOpenDialog).toBe('function')
    expect(typeof mod.ipcRenderer.invoke).toBe('function')
    expect(typeof mod.ipcMain.handle).toBe('function')
    expect(typeof mod.BrowserWindow).toBe('function')
    expect(typeof mod.Menu).toBe('function')
    expect(typeof mod.Tray).toBe('function')

    await mod.app.whenReady()
    expect(mod.app.getVersion()).toBe('0.0.1')
  })

  it('BrowserWindow still refuses when reached through the composed module', async () => {
    vi.stubGlobal('orivon', fakeOrivon())
    const mod = await import('../index.js')
    expect(() => new mod.BrowserWindow()).toThrow(mod.ElectronShimError)
  })
})
