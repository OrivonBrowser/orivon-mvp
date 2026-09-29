import { describe, expect, it, vi } from 'vitest'
import type { ShellWindow } from '../window-registry.js'
import { openUrlsOnSecondLaunch } from '../opener.js'
import type { ShellWindowOptions } from '../window-options.js'
import type { TabManager } from '../tabs.js'

function fakeWindow (overrides: { focused?: boolean, minimized?: boolean } = {}): ShellWindow {
  const window = {
    isFocused: () => overrides.focused ?? false,
    isMinimized: () => overrides.minimized ?? false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn()
  }
  const tabs = { createTab: vi.fn() }
  return { window, tabs } as unknown as ShellWindow
}

describe('openUrlsOnSecondLaunch', () => {
  it('shows and focuses an already-focused window, and opens the urls in it, without creating one', () => {
    const target = fakeWindow({ focused: true })
    const create = vi.fn()

    openUrlsOnSecondLaunch(target, ['https://a.example/'], create)

    expect(target.window.restore).not.toHaveBeenCalled()
    expect(target.window.show).toHaveBeenCalledTimes(1)
    expect(target.window.focus).toHaveBeenCalledTimes(1)
    expect(target.tabs.createTab).toHaveBeenCalledWith('https://a.example/')
    expect(create).not.toHaveBeenCalled()
  })

  it('restores a minimized existing window before showing and focusing it', () => {
    const target = fakeWindow({ focused: false, minimized: true })
    const create = vi.fn()

    openUrlsOnSecondLaunch(target, ['https://b.example/'], create)

    expect(target.window.restore).toHaveBeenCalledTimes(1)
    expect(target.window.show).toHaveBeenCalledTimes(1)
    expect(target.window.focus).toHaveBeenCalledTimes(1)
    expect(target.tabs.createTab).toHaveBeenCalledWith('https://b.example/')
    expect(create).not.toHaveBeenCalled()
  })

  it('opens a new window with the urls in place of its new-tab page, instead of showing one early, when none exists', () => {
    const create = vi.fn()

    openUrlsOnSecondLaunch(undefined, ['https://c.example/'], create)

    expect(create).toHaveBeenCalledTimes(1)
    const options = create.mock.calls[0]?.[0] as ShellWindowOptions
    const tabs = { createTab: vi.fn() }
    options.first?.(tabs as unknown as TabManager)
    expect(tabs.createTab).toHaveBeenCalledWith('https://c.example/')
  })

  it('opens a new window on its own new-tab page when a second launch names no url', () => {
    const create = vi.fn()

    openUrlsOnSecondLaunch(undefined, [], create)

    expect(create).toHaveBeenCalledWith({})
  })
})
