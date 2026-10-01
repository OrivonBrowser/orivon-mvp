import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { popupBlocks } from '../../site-settings/site-popups.js'
import { SHELL_STATE_PARTS } from '../shell-state-parts.js'
import { popupsBlockedStatePart } from '../state/popups-blocked.js'
import type { TabsSnapshot } from '../tab-types.js'
import type { WindowContext } from '../window-context.js'

function rig () {
  const wc = new EventEmitter() as unknown as WebContents
  const ctx = { window: { tabs: { liveWebContents: (id: string) => id === 'a' ? wc : undefined } } } as unknown as WindowContext
  const tabs = (activeTabId: string | null): TabsSnapshot => ({ activeTabId }) as unknown as TabsSnapshot
  return { wc, ctx, tabs }
}

describe('the popups-blocked state part', () => {
  it('is one of the window state parts', () => {
    expect(SHELL_STATE_PARTS.map((part) => part.name)).toContain('popupsBlocked')
  })

  it('counts the windows the active page tried to open', () => {
    const { wc, ctx, tabs } = rig()
    popupBlocks.add(wc, 'https://ads.example/1')
    popupBlocks.add(wc, 'https://ads.example/2')
    expect(popupsBlockedStatePart.read(ctx, tabs('a'))).toEqual({ popupsBlocked: 2 })
  })

  it('reports zero for a page with none, a tab with no live contents, or no active tab', () => {
    const { ctx, tabs } = rig()
    expect(popupsBlockedStatePart.read(ctx, tabs('a'))).toEqual({ popupsBlocked: 0 })
    expect(popupsBlockedStatePart.read(ctx, tabs('gone'))).toEqual({ popupsBlocked: 0 })
    expect(popupsBlockedStatePart.read(ctx, tabs(null))).toEqual({ popupsBlocked: 0 })
  })

  it('pushes when a record changes, and stops when asked', () => {
    const { wc, ctx } = rig()
    const push = vi.fn()
    const stop = popupsBlockedStatePart.watch?.(ctx, push) as () => void
    popupBlocks.add(wc, 'https://ads.example/')
    expect(push).toHaveBeenCalledTimes(1)
    stop()
    popupBlocks.add(wc, 'https://ads.example/again')
    expect(push).toHaveBeenCalledTimes(1)
  })
})
