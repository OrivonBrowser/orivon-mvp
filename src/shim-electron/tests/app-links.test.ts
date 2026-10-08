import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { ElectronShimError } from '../errors.js'
import type { Manifest } from '../../contracts/manifest.js'
import type { Orivon } from '../../contracts/capability-api.js'

const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'

function manifestWith (protocols?: readonly string[]): Manifest {
  return { orivonApiVersion: 0, id: 'com.example.torrent', name: 'Torrent', version: '1.0.0', entry: 'index.html', capabilities: protocols === undefined ? {} : { protocols } }
}

interface Hooks {
  holds?: readonly string[]
  agrees?: boolean
}

function setup (protocols: readonly string[] | null = ['magnet'], hooks: Hooks = {}) {
  const heard: Array<(url: string) => void> = []
  const stops: ReturnType<typeof vi.fn>[] = []
  const requestSchemeHandler = vi.fn(async (_scheme: string) => hooks.agrees ?? true)
  const orivon: Pick<Orivon, 'app'> = {
    app: {
      manifest: async () => manifestWith(protocols ?? undefined),
      grants: async () => [],
      requestGrant: async () => false,
      onOpenUrl: (listener) => {
        heard.push(listener)
        const stop = vi.fn()
        stops.push(stop)
        return stop
      },
      requestSchemeHandler,
      isSchemeHandler: async (scheme) => hooks.holds?.includes(scheme) === true
    }
  }
  return { app: createApp(orivon), heard, stops, requestSchemeHandler }
}

describe('app.setAsDefaultProtocolClient', () => {
  it('asks the person for a scheme the manifest lists, answers false while they decide, and reads true once they agree', async () => {
    const { app, requestSchemeHandler } = setup()
    await app.whenReady()
    expect(app.setAsDefaultProtocolClient('magnet')).toBe(false)
    expect(requestSchemeHandler).toHaveBeenCalledWith('magnet')
    expect(app.isDefaultProtocolClient('magnet')).toBe(false)
    await vi.waitFor(() => { expect(app.isDefaultProtocolClient('magnet')).toBe(true) })
    expect(app.setAsDefaultProtocolClient('magnet')).toBe(true)
    expect(requestSchemeHandler).toHaveBeenCalledTimes(1)
  })

  it('stays false when the person declines', async () => {
    const { app, requestSchemeHandler } = setup(['magnet'], { agrees: false })
    await app.whenReady()
    app.setAsDefaultProtocolClient('magnet')
    await vi.waitFor(() => { expect(requestSchemeHandler).toHaveBeenCalled() })
    await Promise.resolve()
    expect(app.isDefaultProtocolClient('magnet')).toBe(false)
  })

  it('asks nothing for a scheme the manifest does not list', async () => {
    const { app, requestSchemeHandler } = setup(['magnet'])
    await app.whenReady()
    expect(app.setAsDefaultProtocolClient('mailto')).toBe(false)
    expect(requestSchemeHandler).not.toHaveBeenCalled()
    const silent = setup(null)
    await silent.app.whenReady()
    expect(silent.app.setAsDefaultProtocolClient('magnet')).toBe(false)
    expect(silent.requestSchemeHandler).not.toHaveBeenCalled()
  })

  it('reads a default the person chose earlier as of whenReady()', async () => {
    const { app } = setup(['magnet', 'bitcoin'], { holds: ['magnet'] })
    await app.whenReady()
    expect(app.isDefaultProtocolClient('magnet')).toBe(true)
    expect(app.isDefaultProtocolClient('bitcoin')).toBe(false)
    expect(app.isDefaultProtocolClient('MAGNET')).toBe(true)
  })

  it('names the not-ready reason when called before whenReady()', () => {
    const { app } = setup()
    for (const call of [() => app.setAsDefaultProtocolClient('magnet'), () => app.isDefaultProtocolClient('magnet')]) {
      expect(call).toThrow(ElectronShimError)
    }
  })

  it('cannot take itself back out: the person does that in Settings', async () => {
    const { app } = setup(['magnet'], { holds: ['magnet'] })
    await app.whenReady()
    expect(app.removeAsDefaultProtocolClient('magnet')).toBe(false)
    expect(app.isDefaultProtocolClient('magnet')).toBe(true)
  })
})

describe("app.on('open-url')", () => {
  it('hands each link to the listener with an event and the url, and starts listening only when something does', () => {
    const { app, heard } = setup()
    expect(heard).toHaveLength(0)
    const seen: Array<[boolean, string]> = []
    app.on('open-url', (event, url) => { event.preventDefault(); seen.push([event.defaultPrevented, url]) })
    expect(heard).toHaveLength(1)
    heard[0]?.(MAGNET)
    expect(seen).toEqual([[true, MAGNET]])
  })

  it('works before whenReady(), as macOS delivers it before the app is ready', () => {
    const { app, heard } = setup()
    const urls: string[] = []
    app.on('open-url', (_event, url) => { urls.push(url) })
    heard[0]?.(MAGNET)
    expect(urls).toEqual([MAGNET])
  })

  it('subscribes once for any number of listeners, and unsubscribes when the last is removed', () => {
    const { app, heard, stops } = setup()
    const first = vi.fn()
    const second = vi.fn()
    app.on('open-url', first).addListener('open-url', second)
    expect(heard).toHaveLength(1)
    heard[0]?.(MAGNET)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    app.off('open-url', first)
    expect(stops[0]).not.toHaveBeenCalled()
    app.removeListener('open-url', second)
    expect(stops[0]).toHaveBeenCalledTimes(1)
    app.on('open-url', first)
    expect(heard).toHaveLength(2)
  })

  it('once hears one link', () => {
    const { app, heard, stops } = setup()
    const listener = vi.fn()
    app.once('open-url', listener)
    heard[0]?.(MAGNET)
    heard[0]?.(MAGNET)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(stops[0]).toHaveBeenCalledTimes(1)
  })

  it('removeAllListeners stops listening', () => {
    const { app, stops } = setup()
    app.on('open-url', vi.fn())
    app.on('open-url', vi.fn())
    app.removeAllListeners('open-url')
    expect(stops[0]).toHaveBeenCalledTimes(1)
  })

  it('keeps delivering to the rest when one listener throws', () => {
    const { app, heard } = setup()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const second = vi.fn()
    app.on('open-url', () => { throw new Error('app bug') })
    app.on('open-url', second)
    heard[0]?.(MAGNET)
    expect(second).toHaveBeenCalledWith(expect.anything(), MAGNET)
  })

  it('refuses any other app event by name, since a browser delivers none of them', () => {
    const { app } = setup()
    for (const event of ['ready', 'second-instance', 'window-all-closed', 'open-file']) {
      expect(() => (app.on as (name: string, listener: () => void) => unknown)(event, () => {}), event).toThrow(ElectronShimError)
    }
    try {
      (app.on as (name: string, listener: () => void) => unknown)('second-instance', () => {})
    } catch (error) {
      expect((error as ElectronShimError).reason).toBe('unimplemented')
      expect((error as ElectronShimError).api).toBe("app.on('second-instance')")
    }
  })
})
