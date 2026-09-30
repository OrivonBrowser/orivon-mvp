import { describe, expect, it, vi } from 'vitest'
import type { OverlayWindow } from '../../overlays/overlay-types.js'
import { screenshotOverlayFor } from '../screenshot-overlay.js'
import { fakeDeps } from './support.js'

function setup (devTools = false, crashed = false): { handler: ReturnType<ReturnType<typeof screenshotOverlayFor>['attach']>, close: ReturnType<typeof vi.fn>, shots: ReturnType<typeof vi.fn>, toasts: ReturnType<typeof vi.fn>, deps: ReturnType<typeof fakeDeps> } {
  const close = vi.fn()
  const shots = vi.fn(async () => ({ toPNG: () => new Uint8Array([1, 2, 3]), isEmpty: () => false }))
  const toasts = vi.fn()
  const wc = {
    isDestroyed: () => false,
    getURL: () => 'https://a.example/',
    isDevToolsOpened: () => devTools,
    isCrashed: () => crashed,
    capturePage: shots,
    debugger: { attach: vi.fn(), detach: vi.fn(), isAttached: () => false, sendCommand: vi.fn(async () => ({ cssContentSize: { width: 10, height: 10 }, data: 'AQID' })) }
  }
  const window = {
    window: {},
    tabs: { activeWebContents: () => wc, getState: () => ({ tabs: [{ id: 't', title: 'T' }], activeTabId: 't' }) },
    overlays: { show: toasts }
  }
  const deps = fakeDeps('/out/shot.png')
  const handler = screenshotOverlayFor(deps).attach({ window, services: {}, send: vi.fn(), close } as unknown as OverlayWindow)
  return { handler, close, shots, toasts, deps }
}

describe('the screenshot overlay', () => {
  it('is a 340px focused popup sheet that is rebuilt on every show', () => {
    expect(screenshotOverlayFor(fakeDeps())).toMatchObject({ name: 'screenshot', placement: { kind: 'area', at: 'top-center', width: 340 }, focus: 'take', layer: 'popup', keep: 'fresh' })
  })

  it('offers the full page only while developer tools are closed', () => {
    expect(setup().handler.show?.(undefined)).toEqual({ fullPage: true })
    expect(setup(true).handler.show?.(undefined)).toEqual({ fullPage: false })
    expect(setup(false, true).handler.show?.(undefined)).toEqual({ fullPage: false })
  })

  it('ignores everything but exactly the two words it lists', () => {
    const { handler, close, shots } = setup()
    for (const bad of [undefined, null, 'copy', 7, {}, { area: 'visible' }, { to: 'copy' }, { area: 'all', to: 'copy' }, { area: 'visible', to: 'file' }, { area: 'visible', to: 'copy', path: '/etc/passwd' }, { area: 'visible', to: 'save', extra: 1 }]) {
      handler.request(bad)
    }
    expect(close).not.toHaveBeenCalled()
    expect(shots).not.toHaveBeenCalled()
  })

  it('closes first and takes the picture after', async () => {
    const { handler, close, shots, deps } = setup()
    handler.request({ area: 'visible', to: 'copy' })
    expect(close).toHaveBeenCalledTimes(1)
    expect(shots).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(deps.copyImage).toHaveBeenCalledTimes(1) })
    expect(shots).toHaveBeenCalledTimes(1)
  })

  it('falls back to the visible area when a full page is asked for while developer tools are open', async () => {
    const { handler, shots, deps } = setup(true)
    handler.request({ area: 'full', to: 'save' })
    await vi.waitFor(() => { expect(deps.files.get('/out/shot.png')).toBeDefined() })
    expect(shots).toHaveBeenCalledTimes(1)
  })
})
