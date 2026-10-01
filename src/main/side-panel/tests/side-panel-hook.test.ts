import { describe, expect, it, vi } from 'vitest'
import { sidePanelStatePart } from '../../shell/state/side-panel.js'
import { SHELL_STATE_PARTS } from '../../shell/shell-state-parts.js'
import { WINDOW_HOOKS } from '../../shell/window-hooks.js'
import { OVERLAYS } from '../../overlays/overlays.js'
import { fakeWindow } from './panel-fakes.js'
import { sidePanelHook } from '../side-panel-hook.js'
import { sidePanelFor, wireSidePanel } from '../side-panel-host.js'
import { sidePanelOverlay } from '../side-panel-overlay.js'
import { MIN_WINDOW_WIDTH } from '../side-panel-model.js'

describe('registration', () => {
  it('is in each registry the shell reads', () => {
    expect(OVERLAYS).toContain(sidePanelOverlay)
    expect(WINDOW_HOOKS).toContain(sidePanelHook)
    expect(SHELL_STATE_PARTS).toContain(sidePanelStatePart)
  })
})

describe('the window hook', () => {
  it('gives a window its panel when it opens, and takes it back when it closes', () => {
    const win = fakeWindow()
    wireSidePanel(win.ctx.window.window, win.wiring)
    sidePanelHook.opened?.(win.ctx, {})
    const host = sidePanelFor(win.ctx.window)
    host.open()
    expect(host.isOpen()).toBe(true)

    const closed = vi.fn()
    host.setGuest({ id: 'ext:a', title: 'A', view: { setBounds: () => {}, webContents: { isDestroyed: () => false } } as never, closed })
    sidePanelHook.closing?.(win.ctx)
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('follows the side setting while the window is open, and stops when it closes', () => {
    const win = fakeWindow()
    let listener: (change: { key: string }) => void = () => {}
    const stop = vi.fn()
    ;(win.ctx.services.settings as unknown as { onChange: unknown }).onChange = vi.fn((next: typeof listener) => { listener = next; return stop })
    sidePanelHook.opened?.(win.ctx, {})
    const host = sidePanelFor(win.ctx.window)
    host.open()
    win.state.side = 'left'
    listener({ key: 'sidePanel.side' })
    expect(win.sent.at(-1)).toEqual({ type: 'side', side: 'left' })
    sidePanelHook.closing?.(win.ctx)
    expect(stop).toHaveBeenCalledTimes(1)
  })
})

describe('the state part', () => {
  it('reports whether the panel is open, its side and the narrowest window that holds one', () => {
    const win = fakeWindow()
    wireSidePanel(win.ctx.window.window, win.wiring)
    sidePanelHook.opened?.(win.ctx, {})
    const tabs = { tabs: [], activeTabId: null }

    expect(sidePanelStatePart.read(win.ctx, tabs)).toEqual({ sidePanel: { open: false, side: 'right', minWindow: MIN_WINDOW_WIDTH } })
    sidePanelFor(win.ctx.window).open()
    win.state.side = 'left'
    expect(sidePanelStatePart.read(win.ctx, tabs)).toEqual({ sidePanel: { open: true, side: 'left', minWindow: MIN_WINDOW_WIDTH } })
  })

  it('pushes when the panel or the setting changes, and stops with the window', () => {
    const win = fakeWindow()
    const stopSetting = vi.fn()
    ;(win.ctx.services.settings as unknown as { onChange: unknown }).onChange = vi.fn(() => stopSetting)
    wireSidePanel(win.ctx.window.window, win.wiring)
    sidePanelHook.opened?.(win.ctx, {})
    const push = vi.fn()
    const stop = sidePanelStatePart.watch?.(win.ctx, push)
    sidePanelFor(win.ctx.window).open()
    expect(push).toHaveBeenCalledTimes(1)
    stop?.()
    expect(stopSetting).toHaveBeenCalled()
    sidePanelFor(win.ctx.window).close()
    expect(push).toHaveBeenCalledTimes(1)
  })
})
