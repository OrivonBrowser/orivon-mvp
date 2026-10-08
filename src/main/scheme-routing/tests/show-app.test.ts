import { describe, expect, it, vi } from 'vitest'
import type { ShellWindow } from '../../shell/window-registry.js'
import { showApp, type AppWindows } from '../show-app.js'

const APP = 'https://torrent.example'

function shellWindow (): { entry: ShellWindow, activateTab: ReturnType<typeof vi.fn>, createTab: ReturnType<typeof vi.fn>, window: Record<string, ReturnType<typeof vi.fn>> } {
  const activateTab = vi.fn()
  const createTab = vi.fn()
  const window = { isMinimized: vi.fn(() => true), restore: vi.fn(), show: vi.fn(), focus: vi.fn() }
  return { entry: { window, tabs: { activateTab, createTab } } as unknown as ShellWindow, activateTab, createTab, window }
}

describe('showApp', () => {
  it('shows the tab already on the app, in the window that holds it, and opens none', () => {
    const holder = shellWindow()
    const other = shellWindow()
    const tab = {}
    const windows: AppWindows = { liveTabsOn: () => [tab], findTab: (contents) => contents === (tab as never) ? { window: holder.entry, tabId: 't1' } : null, focused: () => other.entry }
    showApp(windows, APP, {})
    expect(holder.activateTab).toHaveBeenCalledWith('t1')
    expect(holder.window['restore']).toHaveBeenCalled()
    expect(holder.window['focus']).toHaveBeenCalled()
    expect(holder.createTab).not.toHaveBeenCalled()
    expect(other.createTab).not.toHaveBeenCalled()
  })

  it('opens the app in a new tab of the window the link came from when none shows it', () => {
    const origin = shellWindow()
    const other = shellWindow()
    const from = {}
    const windows: AppWindows = { liveTabsOn: () => [], findTab: (contents) => contents === (from as never) ? { window: origin.entry, tabId: 't9' } : null, focused: () => other.entry }
    showApp(windows, APP, from)
    expect(origin.createTab).toHaveBeenCalledWith(`${APP}/`, true)
    expect(origin.window['focus']).toHaveBeenCalled()
    expect(other.createTab).not.toHaveBeenCalled()
  })

  it('falls back to the window in use, and does nothing when there is none', () => {
    const focused = shellWindow()
    showApp({ liveTabsOn: () => [], findTab: () => null, focused: () => focused.entry }, APP, undefined)
    expect(focused.createTab).toHaveBeenCalledWith(`${APP}/`, true)
    expect(() => { showApp({ liveTabsOn: () => [], findTab: () => null, focused: () => undefined }, APP, undefined) }).not.toThrow()
  })
})
