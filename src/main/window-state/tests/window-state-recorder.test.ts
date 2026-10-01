import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WindowContext } from '../../shell/window-context.js'
import { windowStateRecorder } from '../window-state-recorder.js'

class FakeWindow extends EventEmitter {
  bounds = { x: 10, y: 20, width: 900, height: 620 }
  maximized = false
  fullScreen = false
  minimized = false
  kiosk = false
  destroyed = false
  getNormalBounds (): typeof this.bounds { return { ...this.bounds } }
  isMaximized (): boolean { return this.maximized }
  isFullScreen (): boolean { return this.fullScreen }
  isMinimized (): boolean { return this.minimized }
  isKiosk (): boolean { return this.kiosk }
  isDestroyed (): boolean { return this.destroyed }
}

function setup (): { win: FakeWindow, set: ReturnType<typeof vi.fn>, ctx: WindowContext } {
  const win = new FakeWindow()
  const set = vi.fn()
  const ctx = { window: { window: win }, services: { windowState: { set } } } as unknown as WindowContext
  windowStateRecorder.opened?.(ctx, {})
  return { win, set, ctx }
}

const tick = async (): Promise<void> => { await new Promise((resolve) => setImmediate(resolve)) }

describe('the window state recorder', () => {
  it('records the place one task after a move, resize or maximise', async () => {
    const { win, set } = setup()
    win.emit('move')
    expect(set).not.toHaveBeenCalled()
    await tick()
    expect(set).toHaveBeenCalledWith({ bounds: win.bounds, maximized: false })

    win.maximized = true
    win.emit('maximize')
    await tick()
    expect(set).toHaveBeenLastCalledWith({ bounds: win.bounds, maximized: true })

    win.maximized = false
    win.emit('unmaximize')
    win.emit('resize')
    await tick()
    expect(set).toHaveBeenLastCalledWith({ bounds: win.bounds, maximized: false })
  })

  it('reads the settled bounds, not the ones at the event', async () => {
    const { win, set } = setup()
    win.emit('resize')
    win.bounds = { x: 10, y: 20, width: 1000, height: 700 }
    await tick()
    expect(set).toHaveBeenCalledWith({ bounds: { x: 10, y: 20, width: 1000, height: 700 }, maximized: false })
  })

  it('shares one read between the events of a burst', async () => {
    const { win, set } = setup()
    for (let i = 0; i < 20; i++) win.emit('resize')
    await tick()
    expect(set).toHaveBeenCalledTimes(1)
  })

  it('leaves the last place alone for a window in full screen, minimised or a kiosk', async () => {
    const { win, set } = setup()
    win.fullScreen = true
    win.emit('resize')
    await tick()
    win.fullScreen = false
    win.minimized = true
    win.emit('move')
    await tick()
    win.minimized = false
    win.kiosk = true
    win.emit('move')
    await tick()
    expect(set).not.toHaveBeenCalled()
  })

  it('writes once more when the window is closing', () => {
    const { win, set, ctx } = setup()
    windowStateRecorder.closing?.(ctx)
    expect(set).toHaveBeenCalledWith({ bounds: win.bounds, maximized: false })
  })

  it('does not touch a window that was destroyed before the read', async () => {
    const { win, set } = setup()
    win.emit('resize')
    win.destroyed = true
    await tick()
    expect(set).not.toHaveBeenCalled()
  })
})
