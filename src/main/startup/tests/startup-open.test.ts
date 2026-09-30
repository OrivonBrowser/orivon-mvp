import { describe, expect, it, vi } from 'vitest'
import { fakeTabs } from '../../session-restore/tests/tabs-fake.js'
import type { SavedWindow } from '../../session-restore/session-types.js'
import { ClosedStack } from '../../session-restore/closed-stack.js'
import { optionsFor } from '../../session-restore/restore.js'
import { fillFirst, restoreWindows, takeOffStack } from '../startup-open.js'

const tab = (url: string, pinned = false) => ({ url, title: '', pinned })
const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } }

describe('fillFirst', () => {
  it('opens the tabs behind, pins as saved, and brings the one that was in front forward', () => {
    const fake = fakeTabs()
    const saved: SavedWindow = { bounds: { x: 0, y: 0, width: 800, height: 600 }, maximized: false, active: 2, tabs: [tab('https://a.example/', true), tab('https://b.example/'), tab('https://c.example/')] }
    fillFirst({ tabs: saved.tabs, urls: [], saved })(fake.tabs)
    expect(fake.calls).toEqual(['create https://a.example/ back', 'create https://b.example/ back', 'create https://c.example/ back', 'activate t3'])
    expect(fake.records.get('t1')?.pinned).toBe(true)
    expect(fake.records.get('t2')?.pinned).toBe(false)
  })

  it('opens the new tab page when nothing could be opened', () => {
    const fake = fakeTabs()
    fillFirst({ tabs: [tab('javascript:alert(1)'), tab('file:///etc/passwd')], urls: [] })(fake.tabs)
    expect(fake.calls).toEqual(['create (new tab page) front'])
  })

  it('puts the command-line addresses after the tabs, the first of them in front', () => {
    const fake = fakeTabs()
    fillFirst({ tabs: [tab('https://a.example/')], urls: ['https://x.example/', 'https://y.example/'] })(fake.tabs)
    expect(fake.calls).toEqual(['create https://a.example/ back', 'create https://x.example/ front', 'create https://y.example/ back'])
  })

  it('stops opening tabs when the window is full', () => {
    const fake = fakeTabs(false)
    fillFirst({ tabs: [tab('https://a.example/')], urls: [] })(fake.tabs)
    expect(fake.calls).toEqual(['create (new tab page) front'])
  })
})

describe('restoreWindows', () => {
  it('opens each window through the display-aware place, not the raw bounds', () => {
    const open = vi.fn()
    const onScreen: SavedWindow = { bounds: { x: 50, y: 60, width: 900, height: 700 }, maximized: true, active: 0, tabs: [tab('https://a.example/')] }
    const gone: SavedWindow = { bounds: { x: 9000, y: 9000, width: 900, height: 700 }, maximized: false, active: 0, tabs: [tab('https://b.example/')] }
    restoreWindows([onScreen, gone], open, [display])
    expect(open.mock.calls[0]?.[0]).toMatchObject({ place: { x: 50, y: 60, width: 900, height: 700 }, maximized: true })
    expect(open.mock.calls[1]?.[0]).not.toHaveProperty('place')
    expect(optionsFor(gone, [display]).maximized).toBe(false)
  })
})

describe('takeOffStack', () => {
  const saved = (url: string): SavedWindow => ({ bounds: { x: 1, y: 1, width: 500, height: 400 }, maximized: false, active: 0, tabs: [{ url, title: '', pinned: false }] })

  it('takes the given windows off the stack and returns the ones that were still on it', () => {
    const [a, b, c] = [saved('https://a.example/'), saved('https://b.example/'), saved('https://c.example/')] as [SavedWindow, SavedWindow, SavedWindow]
    const stack = new ClosedStack()
    for (const window of [a, b, c]) stack.push({ kind: 'window', window })
    stack.pop()
    expect(takeOffStack(stack, [a, b, c])).toEqual([a, b])
    expect(stack.size).toBe(0)
  })
})
