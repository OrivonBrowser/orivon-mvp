import { describe, expect, it, vi } from 'vitest'
import type { ShellWindow } from '../window-registry.js'
import { openUrlsOnSecondLaunch } from '../opener.js'

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
    const createWithUrls = vi.fn()

    openUrlsOnSecondLaunch(target, ['https://a.example/'], createWithUrls)

    expect(target.window.restore).not.toHaveBeenCalled()
    expect(target.window.show).toHaveBeenCalledTimes(1)
    expect(target.window.focus).toHaveBeenCalledTimes(1)
    expect(target.tabs.createTab).toHaveBeenCalledWith('https://a.example/')
    expect(createWithUrls).not.toHaveBeenCalled()
  })

  it('restores a minimized existing window before showing and focusing it', () => {
    const target = fakeWindow({ focused: false, minimized: true })
    const createWithUrls = vi.fn()

    openUrlsOnSecondLaunch(target, ['https://b.example/'], createWithUrls)

    expect(target.window.restore).toHaveBeenCalledTimes(1)
    expect(target.window.show).toHaveBeenCalledTimes(1)
    expect(target.window.focus).toHaveBeenCalledTimes(1)
    expect(target.tabs.createTab).toHaveBeenCalledWith('https://b.example/')
    expect(createWithUrls).not.toHaveBeenCalled()
  })

  it('opens a new window instead of showing one early, when none exists', () => {
    const createWithUrls = vi.fn()

    openUrlsOnSecondLaunch(undefined, ['https://c.example/'], createWithUrls)

    expect(createWithUrls).toHaveBeenCalledWith(['https://c.example/'])
  })
})
