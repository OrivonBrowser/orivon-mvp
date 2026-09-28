import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsStore } from '../../settings/settings-store.js'
import { ZoomService } from '../zoom-service.js'
import { ZoomStore } from '../zoom-store.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-zoom-service-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function built (): Promise<{ zoom: ZoomService, settings: SettingsStore, store: ZoomStore }> {
  const settings = new SettingsStore(join(dir, 'settings.json'))
  const store = new ZoomStore(join(dir, 'zoom.json'))
  await Promise.all([settings.load(), store.load()])
  return { zoom: new ZoomService(store, settings), settings, store }
}

const A = 'https://a.example'

describe('the zoom service', () => {
  it('gives a site its own level, else the default, and a page with no site normal size', async () => {
    const { zoom, settings } = await built()
    expect(zoom.percentFor(A)).toBe(100)
    zoom.step(A, 'in')
    expect(zoom.percentFor(A)).toBe(110)
    expect(zoom.percentFor('https://b.example')).toBe(100)

    settings.set('appearance.defaultZoom', '125')
    expect(zoom.percentFor('https://b.example')).toBe(125)
    expect(zoom.percentFor(A)).toBe(110)
    expect(zoom.percentFor(null)).toBe(100)
  })

  it('steps from the default a site has not chosen for', async () => {
    const { zoom, settings } = await built()
    settings.set('appearance.defaultZoom', '125')
    zoom.step(A, 'in')
    expect(zoom.percentFor(A)).toBe(150)
    zoom.step(A, 'out')
    zoom.step(A, 'out')
    expect(zoom.percentFor(A)).toBe(110)
  })

  it('forgets the choice when a site is put back to the default, so it follows the default again', async () => {
    const { zoom, settings, store } = await built()
    zoom.step(A, 'in')
    zoom.step(A, 'out')
    expect(store.get(A)).toBeUndefined()
    zoom.step(A, 'in')
    zoom.reset(A)
    expect(store.get(A)).toBeUndefined()
    settings.set('appearance.defaultZoom', '150')
    expect(zoom.percentFor(A)).toBe(150)
  })

  it('tells listeners which site changed, and that everything may have when the default did', async () => {
    const { zoom, settings } = await built()
    const heard = vi.fn()
    const stop = zoom.onChange(heard)
    zoom.step(A, 'in')
    settings.set('appearance.defaultZoom', '90')
    settings.set('search.engine', 'brave')
    stop()
    zoom.step(A, 'in')
    expect(heard.mock.calls).toEqual([[A], [null]])
  })
})
