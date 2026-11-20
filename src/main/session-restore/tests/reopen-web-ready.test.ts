import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandDeps } from '../../shortcuts/run-command.js'
import type { ShellServices } from '../../shell/shell-services.js'
import type { NewClosedEntry } from '../closed-stack.js'
import { fakeTabs, shellWindow } from './tabs-fake.js'

const fuse = vi.hoisted(() => ({ known: undefined as string | undefined, reads: 0, finish: (_state: string) => {} }))
vi.mock('../../local-files/file-fuse.js', () => ({
  knownFileProtocolFuse: () => fuse.known,
  fileProtocolFuse: () => new Promise<string>((resolve) => { fuse.reads += 1; fuse.finish = (state) => { fuse.known = state; resolve(state) } })
}))

const webTab = (url = 'https://a.example/1'): NewClosedEntry => ({ kind: 'tab', tab: { url, title: 'Page', pinned: false }, index: 1, windowKey: 1 })
const windowEntry = (url = 'https://w.example/0'): NewClosedEntry => ({
  kind: 'window',
  window: { bounds: { x: 5, y: 6, width: 700, height: 500 }, maximized: true, active: 0, tabs: [{ url, title: 'W', pinned: false }] }
})

/** A fresh gate and a fresh `reopenClosed` over it: the gate's state lasts as long as its module. */
async function setup () {
  vi.resetModules()
  const gate = await import('../../startup/web-ready.js')
  const { ClosedStack } = await import('../closed-stack.js')
  const { reopenClosed, reopenEntry } = await import('../reopen.js')
  const stack = new ClosedStack()
  const fake = fakeTabs()
  fake.order.push('x', 'y')
  const shell = shellWindow(1, fake)
  const openWindow = vi.fn()
  const displays = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]
  const deps = { services: { closedTabs: stack, windows: { all: () => [shell] } } as unknown as ShellServices, openWindow, displays: () => displays, quit: vi.fn() } as CommandDeps
  return { gate, stack, fake, shell, deps, openWindow, reopenClosed, reopenEntry }
}

beforeEach(() => { fuse.known = undefined; fuse.reads = 0; fuse.finish = () => {} })

describe('reopening before web pages may load', () => {
  it('opens no tab, keeps the entry on the stack, and brings the tab back when the gate opens', async () => {
    const { gate, stack, fake, shell, deps, reopenClosed } = await setup()
    stack.push(webTab())
    reopenClosed(shell as never, deps)
    expect(fake.calls).toEqual([])
    expect(stack.size).toBe(1)

    gate.openWebContent()
    await vi.waitFor(() => { expect(stack.size).toBe(0) })
    expect(fake.calls).toEqual(['create https://a.example/1 front', 'move t1 1', 'changed'])
  })

  it('opens the tab once for two presses', async () => {
    const { gate, stack, fake, shell, deps, reopenClosed } = await setup()
    stack.push(webTab())
    reopenClosed(shell as never, deps)
    reopenClosed(shell as never, deps)
    gate.openWebContent()
    await vi.waitFor(() => { expect(stack.size).toBe(0) })
    expect(fake.calls.filter((call) => call.startsWith('create'))).toEqual(['create https://a.example/1 front'])
  })

  it('answers that it opened, so the key stops looking for another entry', async () => {
    const { stack, shell, deps, reopenEntry } = await setup()
    const entry = stack.push(webTab())
    expect(reopenEntry(entry, shell as never, deps)).toBe('opened')
    expect(stack.size).toBe(1)
  })

  it('opens a closed window only when the gate opens', async () => {
    const { gate, stack, shell, deps, openWindow, reopenClosed } = await setup()
    stack.push(windowEntry())
    reopenClosed(shell as never, deps)
    expect(openWindow).not.toHaveBeenCalled()
    expect(stack.size).toBe(1)
    gate.openWebContent()
    await vi.waitFor(() => { expect(openWindow).toHaveBeenCalledOnce() })
    expect(stack.size).toBe(0)
  })

  it('does nothing when the entry was taken off the stack while it waited', async () => {
    const { gate, stack, fake, shell, deps, reopenClosed } = await setup()
    const entry = stack.push(webTab())
    reopenClosed(shell as never, deps)
    stack.take(entry.id)
    gate.openWebContent()
    await Promise.resolve()
    await Promise.resolve()
    expect(fake.calls).toEqual([])
  })

  it('waits for the gate and then for the fuse when the tab is a local file', async () => {
    const { gate, stack, fake, shell, deps, reopenClosed } = await setup()
    stack.push(webTab('file:///home/a/x.html'))
    reopenClosed(shell as never, deps)
    expect(fuse.reads).toBe(0)
    gate.openWebContent()
    await vi.waitFor(() => { expect(fuse.reads).toBe(1) })
    expect(fake.calls).toEqual([])
    expect(stack.size).toBe(1)
    fuse.finish('off')
    await vi.waitFor(() => { expect(stack.size).toBe(0) })
    expect(fake.calls).toEqual(['file file:///home/a/x.html front', 'move t1 1', 'changed'])
  })
})

describe('reopening once web pages may load', () => {
  it('brings the tab back at once', async () => {
    const { gate, stack, fake, shell, deps, reopenClosed } = await setup()
    gate.openWebContent()
    stack.push(webTab())
    reopenClosed(shell as never, deps)
    expect(stack.size).toBe(0)
    expect(fake.calls).toEqual(['create https://a.example/1 front', 'move t1 1', 'changed'])
  })

  it('reopens a closed window at once', async () => {
    const { gate, stack, shell, deps, openWindow, reopenClosed } = await setup()
    gate.openWebContent()
    stack.push(windowEntry())
    reopenClosed(shell as never, deps)
    expect(openWindow).toHaveBeenCalledOnce()
    expect(stack.size).toBe(0)
  })
})
