import { describe, expect, it, vi } from 'vitest'
import type { CommandDeps } from '../../shortcuts/run-command.js'
import type { ShellServices } from '../../shell/shell-services.js'
import { ClosedStack } from '../closed-stack.js'
import type { NewClosedEntry } from '../closed-stack.js'
import { hintFor, reopenClosed, reopenEntry } from '../reopen.js'
import type { SavedWindow } from '../session-types.js'
import { fakeTabs, shellWindow } from './tabs-fake.js'
import type { FakeTabs } from './tabs-fake.js'

const tab = (n: number, extra: Partial<NewClosedEntry & { kind: 'tab' }> = {}): NewClosedEntry => ({
  kind: 'tab', tab: { url: `https://a.example/${String(n)}`, title: `Page ${String(n)}`, pinned: false }, index: n, windowKey: 1, ...extra
})

const savedWindow = (tabs: number): SavedWindow => ({
  bounds: { x: 5, y: 6, width: 700, height: 500 },
  maximized: true,
  active: 1,
  tabs: Array.from({ length: tabs }, (_, n) => ({ url: `https://w.example/${String(n)}`, title: `W${String(n)}`, pinned: false }))
})

function setup (windows: Array<{ id: number, fake: FakeTabs }>) {
  const stack = new ClosedStack()
  const shells = windows.map(({ id, fake }) => shellWindow(id, fake))
  const openWindow = vi.fn()
  const deps = { services: { closedTabs: stack, windows: { all: () => shells } } as unknown as ShellServices, openWindow, quit: vi.fn() } as CommandDeps
  return { stack, shells, deps, openWindow }
}

describe('reopening a closed tab', () => {
  it('brings it back in the window it was closed in, at the place it had, in front', () => {
    const one = fakeTabs()
    one.order.push('x', 'y', 'z')
    const { stack, shells, deps } = setup([{ id: 1, fake: one }])
    stack.push(tab(1))
    reopenClosed(shells[0] as never, deps)
    expect(one.calls).toEqual(['create https://a.example/1 front', 'move t1 1', 'changed'])
    expect(stack.size).toBe(0)
  })

  it('keeps the tab pinned when it was', () => {
    const fake = fakeTabs()
    const { stack, shells, deps } = setup([{ id: 1, fake }])
    stack.push(tab(0, { tab: { url: 'https://a.example/', title: 'Pinned', pinned: true } }))
    reopenClosed(shells[0] as never, deps)
    expect([...fake.records.values()][0]?.pinned).toBe(true)
  })

  it('walks back through what was closed, last closed first, across repeated presses', () => {
    const fake = fakeTabs()
    const { stack, shells, deps } = setup([{ id: 1, fake }])
    stack.push(tab(0))
    stack.push(tab(1))
    stack.push(tab(2))
    for (let press = 0; press < 3; press++) reopenClosed(shells[0] as never, deps)
    expect(fake.calls.filter((call) => call.startsWith('create'))).toEqual(['create https://a.example/2 front', 'create https://a.example/1 front', 'create https://a.example/0 front'])
  })

  it('puts it in the window the key was pressed in when the window it left is gone, and clamps the place', () => {
    const here = fakeTabs()
    const { stack, shells, deps } = setup([{ id: 2, fake: here }])
    stack.push(tab(9, { windowKey: 1 }))
    reopenClosed(shells[0] as never, deps)
    expect(here.calls).toContain('move t1 0')
    expect(shells[0]?.window.focus).not.toHaveBeenCalled()
  })

  it('returns it to its own window when that is another one still open, and brings that window forward', () => {
    const home = fakeTabs()
    const here = fakeTabs()
    const { stack, shells, deps } = setup([{ id: 1, fake: home }, { id: 2, fake: here }])
    stack.push(tab(0, { windowKey: 1 }))
    reopenClosed(shells[1] as never, deps)
    expect(home.calls[0]).toBe('create https://a.example/0 front')
    expect(here.calls).toEqual([])
    expect(shells[0]?.window.focus).toHaveBeenCalled()
  })

  it('does nothing when nothing was closed', () => {
    const fake = fakeTabs()
    const { shells, deps, openWindow } = setup([{ id: 1, fake }])
    expect(() => { reopenClosed(shells[0] as never, deps) }).not.toThrow()
    expect(fake.calls).toEqual([])
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('leaves the entry on the stack when the window has no room', () => {
    const fake = fakeTabs(false)
    const { stack, shells, deps } = setup([{ id: 1, fake }])
    stack.push(tab(1))
    reopenClosed(shells[0] as never, deps)
    expect(stack.size).toBe(1)
    expect(fake.calls).toEqual([])
  })

  it('drops an entry that cannot be opened and reopens the one before it', () => {
    const fake = fakeTabs()
    const { stack, shells, deps } = setup([{ id: 1, fake }])
    stack.push(tab(1))
    stack.push({ kind: 'tab', tab: { url: 'javascript:alert(1)', title: 'bad', pinned: false }, index: 0, windowKey: 1 })
    reopenClosed(shells[0] as never, deps)
    expect(fake.calls.filter((call) => call.startsWith('create'))).toEqual(['create https://a.example/1 front'])
    expect(stack.size).toBe(0)
  })

  it('reopens an entry the person picked from anywhere in the stack, and only that one', () => {
    const fake = fakeTabs()
    const { stack, shells, deps } = setup([{ id: 1, fake }])
    const old = stack.push(tab(1))
    stack.push(tab(2))
    expect(reopenEntry(old, shells[0] as never, deps)).toBe('opened')
    expect(stack.list().map((entry) => entry.kind === 'tab' && entry.index)).toEqual([2])
  })
})

describe('reopening a closed window', () => {
  it('opens a new window with its size, its place, its state and all its tabs', () => {
    const fake = fakeTabs()
    const { stack, shells, deps, openWindow } = setup([{ id: 1, fake }])
    stack.push({ kind: 'window', window: savedWindow(3) })
    reopenClosed(shells[0] as never, deps)
    expect(openWindow).toHaveBeenCalledTimes(1)
    const options = openWindow.mock.calls[0]?.[0]
    expect(options).toMatchObject({ place: { x: 5, y: 6, width: 700, height: 500 }, maximized: true })
    expect(stack.size).toBe(0)

    const fresh = fakeTabs()
    options.first(fresh.tabs)
    expect(fresh.calls.filter((call) => call.startsWith('create'))).toHaveLength(3)
    expect(fresh.calls.at(-1)).toBe('activate t2')
  })
})

describe('hintFor', () => {
  it('is null for an empty stack, the title of the next tab, and a count for a window', () => {
    const stack = new ClosedStack()
    expect(hintFor(stack)).toBeNull()
    stack.push(tab(1))
    expect(hintFor(stack)).toBe('Page 1')
    stack.push({ kind: 'window', window: savedWindow(3) })
    expect(hintFor(stack)).toBe('3 tabs')
    stack.push({ kind: 'window', window: savedWindow(1) })
    expect(hintFor(stack)).toBe('W0')
  })

  it('falls back to the address for an untitled page, and folds line breaks in a title', () => {
    const stack = new ClosedStack()
    stack.push({ kind: 'tab', tab: { url: 'https://a.example/', title: '', pinned: false }, index: 0, windowKey: 1 })
    expect(hintFor(stack)).toBe('https://a.example/')
    stack.push({ kind: 'tab', tab: { url: 'https://a.example/', title: 'One\n  Two', pinned: false }, index: 0, windowKey: 1 })
    expect(hintFor(stack)).toBe('One Two')
  })
})
