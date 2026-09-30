import { describe, expect, it, vi } from 'vitest'
import { SHELL_STATE_PARTS, readStateParts, watchStateParts } from '../shell-state-parts.js'
import type { ShellStatePart } from '../shell-state-parts.js'
import type { WindowContext } from '../window-context.js'

const ctx = { window: {}, services: {} } as unknown as WindowContext
const tabs = { tabs: [], activeTabId: null }

describe('the shell state parts', () => {
  it('ship empty: no field joins the state until a feature adds its line', () => {
    expect(SHELL_STATE_PARTS).toEqual([])
    expect(readStateParts(ctx, tabs)).toEqual({})
  })

  it('merges what every part reads, handing each the window\'s context and the tabs', () => {
    const read = vi.fn(() => ({ zoomPercent: 150 }))
    const parts: ShellStatePart[] = [{ name: 'zoom', read }, { name: 'bar', read: () => ({ bookmarksBar: true }) }]

    expect(readStateParts(ctx, tabs, parts)).toEqual({ zoomPercent: 150, bookmarksBar: true })
    expect(read).toHaveBeenCalledWith(ctx, tabs)
  })

  it('starts the watchers that exist and stops them all with one call', () => {
    const stopA = vi.fn()
    const watchA = vi.fn(() => stopA)
    const push = vi.fn()
    const parts: ShellStatePart[] = [{ name: 'a', read: () => ({}), watch: watchA }, { name: 'quiet', read: () => ({}) }]

    const stop = watchStateParts(ctx, push, parts)
    expect(watchA).toHaveBeenCalledWith(ctx, push)
    expect(stopA).not.toHaveBeenCalled()

    stop()
    expect(stopA).toHaveBeenCalledTimes(1)
  })
})
