import { describe, expect, it, vi } from 'vitest'
import { ClosedStack } from '../closed-stack.js'
import { fillTabs, optionsFor, seedClosedStack } from '../restore.js'
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

describe('optionsFor', () => {
  const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } }

  it('keeps a window where a display still shows it, with its state and a way to fill it', () => {
    const options = optionsFor({ ...saved(['https://a.example/']), bounds: { x: 50, y: 60, width: 800, height: 600 }, maximized: true }, [display])
    expect(options).toMatchObject({ place: { x: 50, y: 60, width: 800, height: 600 }, maximized: true })
    expect(typeof options.first).toBe('function')
  })

  it('drops the place of a window no display shows, such as one last seen on an unplugged monitor', () => {
    const options = optionsFor({ ...saved(['https://a.example/']), bounds: { x: 9000, y: 9000, width: 800, height: 600 } }, [display])
    expect(options).not.toHaveProperty('place')
    expect(options.maximized).toBe(false)
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
