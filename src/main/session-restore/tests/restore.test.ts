import { describe, expect, it, vi } from 'vitest'
import { ClosedStack } from '../closed-stack.js'
import { fillTabs, restoreWindows, seedClosedStack } from '../restore.js'
import type { SavedSession, SavedWindow } from '../session-types.js'
import { fakeTabs } from './tabs-fake.js'

const saved = (urls: string[], active = 0): SavedWindow => ({
  bounds: { x: 1, y: 2, width: 800, height: 600 }, maximized: false, active,
  tabs: urls.map((url) => ({ url, title: '', pinned: false }))
})
const session = (windows: SavedWindow[]): SavedSession => ({ version: 1, clean: false, windows })

describe('fillTabs', () => {
  it('opens every tab in order behind, then brings the one that was in front to the front last', () => {
    const fake = fakeTabs()
    fillTabs(saved(['https://a.example/', 'https://b.example/', 'https://c.example/'], 1))(fake.tabs)
    expect(fake.calls).toEqual(['create https://a.example/ back', 'create https://b.example/ back', 'create https://c.example/ back', 'activate t2'])
  })

  it('opens the new-tab page for a window with nothing to open', () => {
    const fake = fakeTabs()
    fillTabs(saved([]))(fake.tabs)
    expect(fake.calls).toEqual(['create (new tab page) front'])
  })

  it('opens the new-tab page when nothing in the window may be opened', () => {
    const fake = fakeTabs()
    fillTabs(saved(['javascript:alert(1)', 'file:///etc/passwd']))(fake.tabs)
    expect(fake.calls).toEqual(['create (new tab page) front'])
  })

  it('brings a neighbour to the front when the tab that was in front cannot be opened', () => {
    const fake = fakeTabs()
    fillTabs(saved(['https://a.example/', 'javascript:1'], 1))(fake.tabs)
    expect(fake.calls.at(-1)).toBe('activate t1')
  })

  it('stops at the tab limit', () => {
    const fake = fakeTabs()
    fake.room = false
    fillTabs(saved(['https://a.example/']))(fake.tabs)
    expect(fake.calls).toEqual(['create (new tab page) front'])
  })
})

describe('restoreWindows', () => {
  it('opens each window where it was, with its state', () => {
    const openWindow = vi.fn()
    restoreWindows(session([saved(['https://a.example/']), { ...saved(['https://b.example/']), maximized: true }]), openWindow)
    expect(openWindow).toHaveBeenCalledTimes(2)
    expect(openWindow.mock.calls[0]?.[0]).toMatchObject({ place: { x: 1, y: 2, width: 800, height: 600 }, maximized: false })
    expect(openWindow.mock.calls[1]?.[0]).toMatchObject({ maximized: true })
    expect(typeof openWindow.mock.calls[0]?.[0].first).toBe('function')
  })

  it('opens nothing for an empty session', () => {
    const openWindow = vi.fn()
    restoreWindows(session([]), openWindow)
    expect(openWindow).not.toHaveBeenCalled()
  })
})

describe('seedClosedStack', () => {
  it('puts the previous windows on the stack, the last one on top, and skips one with no tab', () => {
    const stack = new ClosedStack()
    seedClosedStack(stack, session([saved(['https://a.example/']), saved([]), saved(['https://b.example/'])]))
    expect(stack.list().map((entry) => entry.kind === 'window' && entry.window.tabs[0]?.url)).toEqual(['https://b.example/', 'https://a.example/'])
  })

  it('does nothing without a previous session', () => {
    const stack = new ClosedStack()
    seedClosedStack(stack, null)
    expect(stack.size).toBe(0)
  })
})
