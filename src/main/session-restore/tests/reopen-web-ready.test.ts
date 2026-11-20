import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandDeps } from '../../shortcuts/run-command.js'
import type { ShellServices } from '../../shell/shell-services.js'
import { ClosedStack } from '../closed-stack.js'
import type { NewClosedEntry } from '../closed-stack.js'
import { reopenClosed, reopenEntry } from '../reopen.js'
import { fakeTabs, shellWindow } from './tabs-fake.js'

const fuse = vi.hoisted(() => ({ known: undefined as string | undefined, reads: 0, finish: (_state: string) => {} }))
vi.mock('../../local-files/file-fuse.js', () => ({
  knownFileProtocolFuse: () => fuse.known,
  fileProtocolFuse: () => new Promise<string>((resolve) => { fuse.reads += 1; fuse.finish = (state) => { fuse.known = state; resolve(state) } })
}))

// The gate, held by the test: what waited runs when `openGate` says. web-ready.test.ts is the one that tests the gate itself.
const gate = vi.hoisted(() => ({ open: false, waiting: [] as Array<() => void> }))
vi.mock('../../startup/web-ready.js', () => ({
  deferUntilWebReady: (later: () => void) => { if (gate.open) return false; gate.waiting.push(later); return true }
}))
const openGate = (): void => { gate.open = true; for (const later of gate.waiting.splice(0)) later() }

const webTab = (url = 'https://a.example/1'): NewClosedEntry => ({ kind: 'tab', tab: { url, title: 'Page', pinned: false }, index: 1, windowKey: 1 })
const windowEntry = (url = 'https://w.example/0'): NewClosedEntry => ({
  kind: 'window',
  window: { bounds: { x: 5, y: 6, width: 700, height: 500 }, maximized: true, active: 0, tabs: [{ url, title: 'W', pinned: false }] }
})

function setup () {
  const stack = new ClosedStack()
  const fake = fakeTabs()
  fake.order.push('x', 'y')
  const shell = shellWindow(1, fake)
  const openWindow = vi.fn()
  const displays = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]
  const deps = { services: { closedTabs: stack, windows: { all: () => [shell] } } as unknown as ShellServices, openWindow, displays: () => displays, quit: vi.fn() } as CommandDeps
  return { stack, fake, shell, deps, openWindow }
}

beforeEach(() => {
  gate.open = false
  gate.waiting.length = 0
  fuse.known = undefined
  fuse.reads = 0
  fuse.finish = () => {}
})

describe('reopening before web pages may load', () => {
  it('opens no tab, keeps the entry on the stack, and brings the tab back when the gate opens', () => {
    const { stack, fake, shell, deps } = setup()
    stack.push(webTab())
    reopenClosed(shell as never, deps)
    expect(fake.calls).toEqual([])
    expect(stack.size).toBe(1)

    openGate()
    expect(stack.size).toBe(0)
    expect(fake.calls).toEqual(['create https://a.example/1 front', 'move t1 1', 'changed'])
  })

  it('opens the tab once for two presses', () => {
    const { stack, fake, shell, deps } = setup()
    stack.push(webTab())
    reopenClosed(shell as never, deps)
    reopenClosed(shell as never, deps)
    openGate()
    expect(stack.size).toBe(0)
    expect(fake.calls.filter((call) => call.startsWith('create'))).toEqual(['create https://a.example/1 front'])
  })

  it('answers that it opened, so the key stops looking for another entry', () => {
    const { stack, shell, deps } = setup()
    const entry = stack.push(webTab())
    expect(reopenEntry(entry, shell as never, deps)).toBe('opened')
    expect(stack.size).toBe(1)
  })

  it('opens a closed window only when the gate opens', () => {
    const { stack, shell, deps, openWindow } = setup()
    stack.push(windowEntry())
    reopenClosed(shell as never, deps)
    expect(openWindow).not.toHaveBeenCalled()
    expect(stack.size).toBe(1)
    openGate()
    expect(openWindow).toHaveBeenCalledOnce()
    expect(stack.size).toBe(0)
  })

  it('does nothing when the entry was taken off the stack while it waited', () => {
    const { stack, fake, shell, deps } = setup()
    const entry = stack.push(webTab())
    reopenClosed(shell as never, deps)
    stack.take(entry.id)
    openGate()
    expect(fake.calls).toEqual([])
  })

  it('does nothing when the window was closed while it waited', () => {
    const { stack, fake, shell, deps } = setup()
    stack.push(webTab())
    reopenClosed(shell as never, deps)
    shell.window.destroyed = true
    openGate()
    expect(fake.calls).toEqual([])
    expect(stack.size).toBe(1)
  })

  it('waits for the gate and then for the fuse when the tab is a local file', async () => {
    const { stack, fake, shell, deps } = setup()
    stack.push(webTab('file:///home/a/x.html'))
    reopenClosed(shell as never, deps)
    expect(fuse.reads).toBe(0)
    openGate()
    expect(fuse.reads).toBe(1)
    expect(fake.calls).toEqual([])
    expect(stack.size).toBe(1)
    fuse.finish('off')
    await vi.waitFor(() => { expect(stack.size).toBe(0) })
    expect(fake.calls).toEqual(['file file:///home/a/x.html front', 'move t1 1', 'changed'])
  })
})

describe('reopening once web pages may load', () => {
  it('brings the tab back at once', () => {
    const { stack, fake, shell, deps } = setup()
    gate.open = true
    stack.push(webTab())
    reopenClosed(shell as never, deps)
    expect(stack.size).toBe(0)
    expect(fake.calls).toEqual(['create https://a.example/1 front', 'move t1 1', 'changed'])
  })

  it('reopens a closed window at once', () => {
    const { stack, shell, deps, openWindow } = setup()
    gate.open = true
    stack.push(windowEntry())
    reopenClosed(shell as never, deps)
    expect(openWindow).toHaveBeenCalledOnce()
    expect(stack.size).toBe(0)
  })
})
