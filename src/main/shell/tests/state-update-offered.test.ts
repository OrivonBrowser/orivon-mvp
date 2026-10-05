import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { SHELL_STATE_PARTS } from '../shell-state-parts.js'
import { updateOfferedStatePart } from '../state/update-offered.js'
import type { TabsSnapshot } from '../tab-types.js'
import type { WindowContext } from '../window-context.js'

function rig (url: string, offered: readonly string[], destroyed = false) {
  const wc = { getURL: () => url, isDestroyed: () => destroyed } as unknown as WebContents
  const listeners = new Set<(origin: string) => void>()
  const ctx = {
    window: { tabs: { liveWebContents: (id: string) => id === 'a' ? wc : undefined } },
    services: { updateOffers: { pending: (origin: string) => offered.includes(origin) ? {} : undefined, onChange: (listener: (origin: string) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } } }
  } as unknown as WindowContext
  const tabs = (activeTabId: string | null): TabsSnapshot => ({ activeTabId }) as unknown as TabsSnapshot
  return { ctx, tabs, listeners }
}

describe('the update-offered state part', () => {
  it('is one of the window state parts', () => {
    expect(SHELL_STATE_PARTS.map((part) => part.name)).toContain('updateOffered')
  })

  it('is true for the active page when its origin has an update offered', () => {
    const { ctx, tabs } = rig('https://app.eth/inbox', ['https://app.eth'])
    expect(updateOfferedStatePart.read(ctx, tabs('a'))).toEqual({ updateOffered: true })
    const other = rig('https://other.eth/', ['https://app.eth'])
    expect(updateOfferedStatePart.read(other.ctx, other.tabs('a'))).toEqual({ updateOffered: false })
  })

  it('is false with no active tab, no live contents, destroyed contents or an address that is no origin', () => {
    const { ctx, tabs } = rig('https://app.eth/', ['https://app.eth'])
    expect(updateOfferedStatePart.read(ctx, tabs(null))).toEqual({ updateOffered: false })
    expect(updateOfferedStatePart.read(ctx, tabs('gone'))).toEqual({ updateOffered: false })
    const dead = rig('https://app.eth/', ['https://app.eth'], true)
    expect(updateOfferedStatePart.read(dead.ctx, dead.tabs('a'))).toEqual({ updateOffered: false })
    const blank = rig('about:blank', [])
    expect(updateOfferedStatePart.read(blank.ctx, blank.tabs('a'))).toEqual({ updateOffered: false })
  })

  it('pushes when an offer appears or goes, and stops when asked', () => {
    const push = vi.fn()
    const { ctx, listeners } = rig('https://app.eth/', [])
    const stop = updateOfferedStatePart.watch?.(ctx, push) as () => void
    for (const listener of listeners) listener('https://app.eth')
    expect(push).toHaveBeenCalledTimes(1)
    stop()
    expect(listeners.size).toBe(0)
  })
})
