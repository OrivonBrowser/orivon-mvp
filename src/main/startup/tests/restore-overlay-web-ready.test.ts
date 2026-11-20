import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedSession, SavedWindow } from '../../session-restore/session-types.js'

const fuse = vi.hoisted(() => ({ known: undefined as string | undefined, reads: 0, finish: (_state: string) => {} }))
vi.mock('../../local-files/file-fuse.js', () => ({
  knownFileProtocolFuse: () => fuse.known,
  fileProtocolFuse: () => new Promise<string>((resolve) => { fuse.reads += 1; fuse.finish = (state) => { fuse.known = state; resolve(state) } })
}))

const saved = (url: string): SavedWindow => ({ bounds: { x: 10, y: 10, width: 800, height: 600 }, maximized: false, active: 0, tabs: [{ url, title: '', pinned: false }] })
const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } }

/** A fresh gate and a fresh bar over it: the gate's state lasts as long as its module. */
async function setup (previous: SavedSession) {
  vi.resetModules()
  const gate = await import('../web-ready.js')
  const { ClosedStack } = await import('../../session-restore/closed-stack.js')
  const { restoreOverlayFor } = await import('../restore-overlay.js')
  const closedTabs = new ClosedStack()
  for (const window of previous.windows) closedTabs.push({ kind: 'window', window })
  const openWindow = vi.fn()
  const close = vi.fn()
  const overlay = restoreOverlayFor({ displays: () => [display] })
  const handler = overlay.attach({ window: { tabs: { openInternal: vi.fn() } }, services: { session: { previous: () => previous }, closedTabs, commands: { openWindow }, shortcuts: { keysOf: () => [] } }, close } as never)
  return { gate, handler, openWindow, close, closedTabs }
}

const web: SavedSession = { version: 1, clean: false, windows: [saved('https://a.example/'), saved('https://b.example/')] }

beforeEach(() => { fuse.known = undefined; fuse.reads = 0; fuse.finish = () => {} })

describe('the restore bar before web pages may load', () => {
  it('opens no window on Restore, then opens every one when the gate opens', async () => {
    const { gate, handler, openWindow, close } = await setup(web)
    handler.request({ type: 'restore' })
    expect(close).toHaveBeenCalledOnce()
    expect(openWindow).not.toHaveBeenCalled()

    gate.openWebContent()
    await vi.waitFor(() => { expect(openWindow).toHaveBeenCalledTimes(2) })
  })

  it('takes the windows off the closed stack at once, so Reopen cannot bring the same ones back meanwhile', async () => {
    const { handler, closedTabs } = await setup(web)
    handler.request({ type: 'restore' })
    expect(closedTabs.size).toBe(0)
  })

  it('opens the windows once for a second press on Restore', async () => {
    const { gate, handler, openWindow } = await setup(web)
    handler.request({ type: 'restore' })
    handler.request({ type: 'restore' })
    gate.openWebContent()
    await vi.waitFor(() => { expect(openWindow).toHaveBeenCalledTimes(2) })
    await Promise.resolve()
    expect(openWindow).toHaveBeenCalledTimes(2)
  })

  it('waits for the gate and then for the fuse when a saved tab is a local file', async () => {
    const { gate, handler, openWindow } = await setup({ version: 1, clean: false, windows: [saved('file:///home/a/x.html'), saved('https://b.example/')] })
    handler.request({ type: 'restore' })
    expect(fuse.reads).toBe(0)
    gate.openWebContent()
    await vi.waitFor(() => { expect(fuse.reads).toBe(1) })
    expect(openWindow).not.toHaveBeenCalled()
    fuse.finish('off')
    await vi.waitFor(() => { expect(openWindow).toHaveBeenCalledTimes(2) })
  })
})

describe('the restore bar once web pages may load', () => {
  it('opens the windows on Restore at once', async () => {
    const { gate, handler, openWindow } = await setup(web)
    gate.openWebContent()
    handler.request({ type: 'restore' })
    expect(openWindow).toHaveBeenCalledTimes(2)
  })
})
