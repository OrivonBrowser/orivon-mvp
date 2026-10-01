import { describe, expect, it, vi } from 'vitest'
import { SHELL_STATE_PARTS } from '../shell-state-parts.js'
import { addressBarStatePart } from '../state/address-bar.js'
import type { WindowContext } from '../window-context.js'

function context (on: boolean): { ctx: WindowContext, change: (key: string) => void, removed: ReturnType<typeof vi.fn> } {
  let listener: (change: { key: string }) => void = () => {}
  const removed = vi.fn()
  const settings = {
    get: (key: string) => (key === 'addressBar.showFullUrl' ? on : undefined),
    onChange: (next: typeof listener) => { listener = next; return removed }
  }
  return { ctx: { services: { settings } } as unknown as WindowContext, change: (key) => { listener({ key }) }, removed }
}

describe('the address bar state part', () => {
  it('is registered', () => {
    expect(SHELL_STATE_PARTS).toContain(addressBarStatePart)
  })

  it('reads whether the bar shows full addresses', () => {
    const tabs = { tabs: [], activeTabId: null }
    expect(addressBarStatePart.read(context(true).ctx, tabs)).toEqual({ showFullUrl: true })
    expect(addressBarStatePart.read(context(false).ctx, tabs)).toEqual({ showFullUrl: false })
  })

  it('pushes when that setting changes, and for no other', () => {
    const { ctx, change, removed } = context(false)
    const push = vi.fn()
    const stop = addressBarStatePart.watch?.(ctx, push)
    change('search.engine')
    expect(push).not.toHaveBeenCalled()
    change('addressBar.showFullUrl')
    expect(push).toHaveBeenCalledTimes(1)
    stop?.()
    expect(removed).toHaveBeenCalled()
  })
})
