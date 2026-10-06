import { describe, expect, it, vi } from 'vitest'
import { SHELL_STATE_PARTS, readStateParts, watchStateParts } from '../shell-state-parts.js'
import type { ShellStatePart } from '../shell-state-parts.js'
import type { WindowContext } from '../window-context.js'

const ctx = { window: {}, services: {} } as unknown as WindowContext
const tabs = { tabs: [], activeTabId: null }

describe('the shell state parts', () => {
  it('adds no field when no part is registered', () => {
    expect(SHELL_STATE_PARTS.map((part) => part.name)).toEqual(['addressBar', 'bookmarked', 'contentBlocked', 'downloads', 'extensions', 'groups', 'home', 'logins', 'popupsBlocked', 'sharing', 'shortcuts', 'sidePanel', 'siteAccess', 'updateOffered'])
    expect(readStateParts(ctx, tabs, [])).toEqual({})
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

  it('contains a part that throws: it is logged by name, adds nothing, and the others still count', () => {
    const complaint = vi.spyOn(console, 'error').mockImplementation(() => {})
    const boom = (): never => { throw new Error('boom') }
    const parts: ShellStatePart[] = [
      { name: 'broken', read: boom, watch: boom },
      { name: 'zoom', read: () => ({ zoomPercent: 150 }) },
      { name: 'stops-badly', read: () => ({}), watch: () => boom }
    ]

    expect(readStateParts(ctx, tabs, parts)).toEqual({ zoomPercent: 150 })
    const stop = watchStateParts(ctx, vi.fn(), parts)
    expect(() => { stop() }).not.toThrow()
    const logged = complaint.mock.calls.map((call) => String(call[0]))
    expect(logged.some((line) => line.includes('broken'))).toBe(true)
    expect(logged.some((line) => line.includes('stops-badly'))).toBe(true)
    complaint.mockRestore()
  })
})
