import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClosedStack } from '../../session-restore/closed-stack.js'
import type { SavedSession, SavedWindow } from '../../session-restore/session-types.js'
import { restoreOverlayFor } from '../restore-overlay.js'

const fuse = vi.hoisted(() => ({ known: undefined as string | undefined, reads: 0, finish: (_state: string) => {} }))
vi.mock('../../local-files/file-fuse.js', () => ({
  knownFileProtocolFuse: () => fuse.known,
  fileProtocolFuse: () => new Promise<string>((resolve) => { fuse.reads += 1; fuse.finish = (state) => { fuse.known = state; resolve(state) } })
}))

// The gate, held by the test: what waited runs when `openGate` says. web-ready.test.ts is the one that tests the gate itself.
const gate = vi.hoisted(() => ({ open: false, waiting: [] as Array<() => void> }))
vi.mock('../web-ready.js', () => ({
  deferUntilWebReady: (later: () => void) => { if (gate.open) return false; gate.waiting.push(later); return true }
}))
const openGate = (): void => { gate.open = true; for (const later of gate.waiting.splice(0)) later() }

const saved = (url: string): SavedWindow => ({ bounds: { x: 10, y: 10, width: 800, height: 600 }, maximized: false, active: 0, tabs: [{ url, title: '', pinned: false }] })
const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } }

function setup (previous: SavedSession) {
  const closedTabs = new ClosedStack()
  for (const window of previous.windows) closedTabs.push({ kind: 'window', window })
  const openWindow = vi.fn()
  const close = vi.fn()
  const overlay = restoreOverlayFor({ displays: () => [display] })
  const handler = overlay.attach({ window: { tabs: { openInternal: vi.fn() } }, services: { session: { previous: () => previous }, closedTabs, commands: { openWindow }, shortcuts: { keysOf: () => [] } }, close } as never)
  return { handler, openWindow, close, closedTabs }
}

const web: SavedSession = { version: 1, clean: false, windows: [saved('https://a.example/'), saved('https://b.example/')] }

beforeEach(() => {
  gate.open = false
  gate.waiting.length = 0
  fuse.known = undefined
  fuse.reads = 0
  fuse.finish = () => {}
})

describe('the restore bar before web pages may load', () => {
  it('opens no window on Restore, then opens every one when the gate opens', () => {
    const { handler, openWindow, close } = setup(web)
    handler.request({ type: 'restore' })
    expect(close).toHaveBeenCalledOnce()
    expect(openWindow).not.toHaveBeenCalled()

    openGate()
    expect(openWindow).toHaveBeenCalledTimes(2)
  })

  it('takes the windows off the closed stack at once, so Reopen cannot bring the same ones back meanwhile', () => {
    const { handler, closedTabs } = setup(web)
    handler.request({ type: 'restore' })
    expect(closedTabs.size).toBe(0)
  })

  it('opens the windows once for a second press on Restore', () => {
    const { handler, openWindow } = setup(web)
    handler.request({ type: 'restore' })
    handler.request({ type: 'restore' })
    openGate()
    expect(openWindow).toHaveBeenCalledTimes(2)
  })

  it('waits for the gate and then for the fuse when a saved tab is a local file', async () => {
    const { handler, openWindow } = setup({ version: 1, clean: false, windows: [saved('file:///home/a/x.html'), saved('https://b.example/')] })
    handler.request({ type: 'restore' })
    expect(fuse.reads).toBe(0)
    openGate()
    expect(fuse.reads).toBe(1)
    expect(openWindow).not.toHaveBeenCalled()
    fuse.finish('off')
    await vi.waitFor(() => { expect(openWindow).toHaveBeenCalledTimes(2) })
  })
})

describe('the restore bar once web pages may load', () => {
  it('opens the windows on Restore at once', () => {
    const { handler, openWindow } = setup(web)
    gate.open = true
    handler.request({ type: 'restore' })
    expect(openWindow).toHaveBeenCalledTimes(2)
  })
})
