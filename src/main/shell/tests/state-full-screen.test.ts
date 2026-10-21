import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { SHELL_STATE_PARTS } from '../shell-state-parts.js'
import { fullScreenStatePart } from '../state/full-screen.js'
import type { WindowContext } from '../window-context.js'

function context (full: boolean): { ctx: WindowContext, win: EventEmitter & { full: boolean } } {
  const win = Object.assign(new EventEmitter(), { full, isFullScreen () { return this.full } })
  return { ctx: { window: { window: win } } as unknown as WindowContext, win }
}

const tabs = { tabs: [], activeTabId: null }

describe('the full-screen state part', () => {
  it('is registered', () => {
    expect(SHELL_STATE_PARTS).toContain(fullScreenStatePart)
  })

  it('reads whether the window fills the screen', () => {
    expect(fullScreenStatePart.read(context(true).ctx, tabs)).toEqual({ fullScreen: true })
    expect(fullScreenStatePart.read(context(false).ctx, tabs)).toEqual({ fullScreen: false })
  })

  it('pushes as the window enters and leaves full screen, and lets go of the window when stopped', () => {
    const { ctx, win } = context(false)
    const push = vi.fn()
    const stop = fullScreenStatePart.watch?.(ctx, push)
    win.emit('resize')
    expect(push).not.toHaveBeenCalled()
    win.emit('enter-full-screen')
    win.emit('leave-full-screen')
    expect(push).toHaveBeenCalledTimes(2)
    stop?.()
    expect(win.listenerCount('enter-full-screen') + win.listenerCount('leave-full-screen')).toBe(0)
  })
})
