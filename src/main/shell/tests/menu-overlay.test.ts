import { describe, expect, it, vi } from 'vitest'
import { menuOverlay } from '../menu-overlay.js'
import type { OverlayWindow } from '../../overlays/overlay-types.js'

function attach (url = 'https://a.example/'): { handler: ReturnType<typeof menuOverlay.attach>, run: ReturnType<typeof vi.fn>, close: ReturnType<typeof vi.fn> } {
  const rows = ['tab.new', 'split.toggle', 'window.alwaysOnTop', 'zoom.in', 'zoom.out', 'zoom.reset', 'window.fullscreen', 'tab.close', 'devtools.toggle', 'history.open', 'bookmark.toggle', 'window.new', 'window.newPrivate', 'extensions.open', 'profiles.open', 'settings.open', 'app.quit']
    .map((id) => ({ id, label: id, keys: null }))
  const run = vi.fn()
  const close = vi.fn()
  const win = {
    window: { window: { isAlwaysOnTop: () => false }, tabs: { getState: () => ({ tabs: [{ id: 'a', url }], activeTabId: 'a' }) } },
    services: { shortcuts: { rows: () => rows }, zoom: { percentFor: () => 110 }, commands: { run } },
    send: vi.fn(),
    close
  } as unknown as OverlayWindow
  return { handler: menuOverlay.attach(win), run, close }
}

describe('the menu overlay', () => {
  it('is a warm popup under the menu button', () => {
    expect(menuOverlay).toMatchObject({ name: 'menu', surface: 'menu', layer: 'popup', keep: 'warm', focus: 'take' })
    expect(menuOverlay.placement).toEqual({ kind: 'anchor', width: 380, align: 'right' })
  })

  it('answers each show with the items', () => {
    const { handler } = attach()
    const items = handler.show?.(undefined) as Array<{ kind: string }>
    expect(items.map((item) => item.kind)).toContain('zoom')
  })

  it('runs a listed command, closing the menu first, and answers nothing', () => {
    const { handler, run, close } = attach()
    expect(handler.request({ type: 'run', id: 'tab.new' })).toBeUndefined()
    expect(close).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('tab.new', expect.anything())
  })

  it('runs a command inside a submenu', () => {
    const { handler, run } = attach()
    handler.request({ type: 'run', id: 'split.toggle' })
    expect(run).toHaveBeenCalledWith('split.toggle', expect.anything())
  })

  it('with stay, keeps the menu open and answers the fresh items', () => {
    const { handler, run, close } = attach()
    const fresh = handler.request({ type: 'run', id: 'zoom.in', stay: true })
    expect(run).toHaveBeenCalledWith('zoom.in', expect.anything())
    expect(close).not.toHaveBeenCalled()
    expect(Array.isArray(fresh)).toBe(true)
  })

  it('refuses a command the menu does not list, an unknown one, and anything malformed', () => {
    const { handler, run, close } = attach()
    for (const command of [undefined, null, 'tab.new', {}, { type: 'run' }, { type: 'run', id: 7 }, { type: 'go', id: 'tab.new' },
      { type: 'run', id: 'tab.close' }, { type: 'run', id: 'no.such' }, { type: 'run', id: '__proto__' }, { type: 'run', id: 'tab.new', stay: 'yes' }]) {
      expect(handler.request(command), JSON.stringify(command)).toBeUndefined()
    }
    expect(run).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('refuses the zoom commands on a page with no zoom of its own', () => {
    const { handler, run } = attach('orivon://newtab/')
    handler.request({ type: 'run', id: 'zoom.in', stay: true })
    expect(run).not.toHaveBeenCalled()
    handler.request({ type: 'run', id: 'window.fullscreen' })
    expect(run).toHaveBeenCalledTimes(1)
  })
})
