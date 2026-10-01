import { describe, expect, it, vi } from 'vitest'
import { SHELL_STATE_PARTS } from '../shell-state-parts.js'
import { homeStatePart } from '../state/home.js'
import type { WindowContext } from '../window-context.js'

function context (on: boolean): { ctx: WindowContext, change: (key: string) => void, removed: ReturnType<typeof vi.fn> } {
  let listener: (change: { key: string }) => void = () => {}
  const removed = vi.fn()
  const settings = {
    get: (key: string) => (key === 'toolbar.home' ? on : undefined),
    onChange: (next: typeof listener) => { listener = next; return removed }
  }
  return { ctx: { services: { settings } } as unknown as WindowContext, change: (key) => { listener({ key }) }, removed }
}

describe('the home state part', () => {
  it('is registered', () => {
    expect(SHELL_STATE_PARTS).toContain(homeStatePart)
  })

  it('reads whether the Home button shows', () => {
    const tabs = { tabs: [], activeTabId: null }
    expect(homeStatePart.read(context(true).ctx, tabs)).toEqual({ homeButton: true })
    expect(homeStatePart.read(context(false).ctx, tabs)).toEqual({ homeButton: false })
  })

  it('pushes when that setting changes, and for no other', () => {
    const { ctx, change, removed } = context(true)
    const push = vi.fn()
    const stop = homeStatePart.watch?.(ctx, push)
    change('appearance.theme')
    expect(push).not.toHaveBeenCalled()
    change('toolbar.home')
    expect(push).toHaveBeenCalledTimes(1)
    stop?.()
    expect(removed).toHaveBeenCalled()
  })
})
