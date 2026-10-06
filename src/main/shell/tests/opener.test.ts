import { describe, expect, it, vi } from 'vitest'
import type { ShellWindow } from '../window-registry.js'
import { answerLaunch } from '../opener.js'
import type { LaunchRequest } from '../../launch/launch-request.js'
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

const open = (urls: string[]): LaunchRequest => ({ kind: 'open', urls })
const actions = (create: (options: ShellWindowOptions) => void, openPrivate: (urls: readonly string[]) => boolean = () => true, kiosk = false): Parameters<typeof answerLaunch>[2] => ({ create, openPrivate, kiosk })

describe('answering an open request', () => {
  it('shows and focuses an already-focused window, and opens the urls in it, without creating one', () => {
    const target = fakeWindow({ focused: true })
    const create = vi.fn()

    answerLaunch(open(['https://a.example/']), target, actions(create))

    expect(target.window.restore).not.toHaveBeenCalled()
    expect(target.window.show).toHaveBeenCalledTimes(1)
    expect(target.window.focus).toHaveBeenCalledTimes(1)
    expect(target.tabs.createTab).toHaveBeenCalledWith('https://a.example/', true)
    expect(create).not.toHaveBeenCalled()
  })

  it('restores a minimized existing window before showing and focusing it', () => {
    const target = fakeWindow({ focused: false, minimized: true })
    const create = vi.fn()

    answerLaunch(open(['https://b.example/']), target, actions(create))

    expect(target.window.restore).toHaveBeenCalledTimes(1)
    expect(target.window.show).toHaveBeenCalledTimes(1)
    expect(target.window.focus).toHaveBeenCalledTimes(1)
    expect(target.tabs.createTab).toHaveBeenCalledWith('https://b.example/', true)
    expect(create).not.toHaveBeenCalled()
  })

  it('opens a new window with the urls in place of its new-tab page, instead of showing one early, when none exists', () => {
    const create = vi.fn()

    answerLaunch(open(['https://c.example/']), undefined, actions(create))

    expect(create).toHaveBeenCalledTimes(1)
    const options = create.mock.calls[0]?.[0] as ShellWindowOptions
    const tabs = { createTab: vi.fn() }
    options.first?.(tabs as unknown as TabManager)
    expect(tabs.createTab).toHaveBeenCalledWith('https://c.example/', true)
  })

  it('opens a new window on its own new-tab page when a second launch names no url', () => {
    const create = vi.fn()

    answerLaunch(open([]), undefined, actions(create))

    expect(create).toHaveBeenCalledWith({})
  })
})

describe('answering a window request', () => {
  it('opens a new window with the urls and leaves the window in use alone', () => {
    const target = fakeWindow({ focused: true, minimized: true })
    const create = vi.fn()

    answerLaunch({ kind: 'window', urls: ['https://a.example/'] }, target, actions(create))

    expect(create).toHaveBeenCalledTimes(1)
    const tabs = { createTab: vi.fn() }
    ;(create.mock.calls[0]?.[0] as ShellWindowOptions).first?.(tabs as unknown as TabManager)
    expect(tabs.createTab).toHaveBeenCalledWith('https://a.example/', true)
    expect(target.window.restore).not.toHaveBeenCalled()
    expect(target.window.show).not.toHaveBeenCalled()
    expect(target.window.focus).not.toHaveBeenCalled()
    expect(target.tabs.createTab).not.toHaveBeenCalled()
  })

  it('opens a window on its new-tab page when it names no address', () => {
    const create = vi.fn()
    answerLaunch({ kind: 'window', urls: [] }, fakeWindow(), actions(create))
    expect(create).toHaveBeenCalledWith({})
  })
})

describe('answering a private request', () => {
  it('starts a private session with every address, and opens no window here', () => {
    const create = vi.fn()
    const openPrivate = vi.fn(() => true)
    const target = fakeWindow()

    answerLaunch({ kind: 'private', urls: ['https://a.example/', 'https://b.example/'] }, target, actions(create, openPrivate))

    expect(openPrivate).toHaveBeenCalledWith(['https://a.example/', 'https://b.example/'])
    expect(create).not.toHaveBeenCalled()
    expect(target.window.focus).not.toHaveBeenCalled()
  })
})

describe('answering in a kiosk', () => {
  it('only shows the window it has, whatever was asked', () => {
    const target = fakeWindow()
    const create = vi.fn()
    const openPrivate = vi.fn(() => true)
    for (const kind of ['window', 'private'] as const) answerLaunch({ kind, urls: ['https://a.example/'] }, target, actions(create, openPrivate, true))

    expect(target.window.show).toHaveBeenCalledTimes(2)
    expect(target.tabs.createTab).toHaveBeenCalledTimes(2)
    expect(create).not.toHaveBeenCalled()
    expect(openPrivate).not.toHaveBeenCalled()
  })
})
