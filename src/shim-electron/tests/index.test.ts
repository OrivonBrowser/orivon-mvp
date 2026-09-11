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

/**
 * A realistic slice of real `electron`'s top-level export surface -- the
 * names real ported apps reach for most, and that this package left simply
 * absent before this file. Every one of them must now either work (the four
 * rows above) or throw a named, non-generic error; none may resolve to
 * `undefined` and then blow up with a bare `TypeError` at the caller's own
 * call site, which is the defect this whole file exists to close.
 */
const NOT_YET_CONSIDERED = [
  'shell', 'clipboard', 'session', 'protocol', 'webContents', 'nativeImage',
  'screen', 'contextBridge', 'crashReporter', 'powerMonitor',
  'systemPreferences', 'globalShortcut', 'nativeTheme', 'webFrame', 'desktopCapturer'
] as const

describe('electron exports this package has not yet considered', () => {
  it.each(NOT_YET_CONSIDERED)('%s exists as a real export, not undefined', async (name) => {
    vi.stubGlobal('orivon', fakeOrivon())
    const mod = await import('../index.js') as unknown as Record<string, unknown>
    expect(mod[name]).toBeDefined()
  })

  it.each(NOT_YET_CONSIDERED)('%s.someMethod throws a named error, never a bare TypeError', async (name) => {
    vi.stubGlobal('orivon', fakeOrivon())
    const mod = await import('../index.js')
    const member = (mod as unknown as Record<string, Record<string, unknown>>)[name]!
    expect(() => member.someMethod).toThrow(mod.ElectronShimError)
    try {
      void member.someMethod
    } catch (error) {
      expect((error as Error).name).not.toBe('TypeError')
      expect((error as Error).name).toBe('ElectronShimError')
      expect((error as { reason?: string }).reason).toBe('unimplemented')
      expect((error as { api?: string }).api).toBe(`${name}.someMethod`)
    }
  })
})

describe('the default export', () => {
  it('serves every named export as properties of one object, unchanged', async () => {
    vi.stubGlobal('orivon', fakeOrivon())
    const mod = await import('../index.js')
    await mod.app.whenReady()
    expect(mod.default.app).toBe(mod.app)
    expect(mod.default.dialog).toBe(mod.dialog)
    expect(mod.default.shell).toBe(mod.shell)
  })

  it('throws for a name this package has never even listed -- genuinely total, not curated', async () => {
    vi.stubGlobal('orivon', fakeOrivon())
    const mod = await import('../index.js')
    const asAny = mod.default as unknown as Record<string, unknown>
    expect(() => asAny.autoUpdater).toThrow(mod.ElectronShimError)
  })

  it('the same unlisted name read off the plain namespace stays undefined -- a real ESM limit, not an oversight (see README)', async () => {
    vi.stubGlobal('orivon', fakeOrivon())
    const mod = await import('../index.js') as unknown as Record<string, unknown>
    expect(mod.autoUpdater).toBeUndefined()
  })
})
