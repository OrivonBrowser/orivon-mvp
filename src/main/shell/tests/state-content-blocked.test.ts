import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { siteContentBlocks } from '../../site-settings/site-content-blocks.js'
import { SHELL_STATE_PARTS } from '../shell-state-parts.js'
import { contentBlockedStatePart } from '../state/content-blocked.js'
import type { TabsSnapshot } from '../tab-types.js'
import type { WindowContext } from '../window-context.js'

afterEach(() => { siteContentBlocks.bind(() => false) })

function rig (url: string, destroyed = false) {
  const wc = Object.assign(new EventEmitter(), { getURL: () => url, isDestroyed: () => destroyed }) as unknown as WebContents
  const ctx = { window: { tabs: { liveWebContents: (id: string) => id === 'a' ? wc : undefined } } } as unknown as WindowContext
  const tabs = (activeTabId: string | null): TabsSnapshot => ({ activeTabId }) as unknown as TabsSnapshot
  return { ctx, tabs }
}

describe('the content-blocked state part', () => {
  it('is one of the window state parts', () => {
    expect(SHELL_STATE_PARTS.map((part) => part.name)).toContain('contentBlocked')
  })

  it('is true for the active page when its site has something switched off', () => {
    siteContentBlocks.bind((url) => url === 'https://quiet.example/')
    expect(contentBlockedStatePart.read(rig('https://quiet.example/').ctx, rig('x').tabs('a'))).toEqual({ contentBlocked: true })
    expect(contentBlockedStatePart.read(rig('https://loud.example/').ctx, rig('x').tabs('a'))).toEqual({ contentBlocked: false })
  })

  it('is false with no active tab, no live contents or destroyed contents', () => {
    siteContentBlocks.bind(() => true)
    const { ctx, tabs } = rig('https://quiet.example/')
    expect(contentBlockedStatePart.read(ctx, tabs(null))).toEqual({ contentBlocked: false })
    expect(contentBlockedStatePart.read(ctx, tabs('gone'))).toEqual({ contentBlocked: false })
    const dead = rig('https://quiet.example/', true)
    expect(contentBlockedStatePart.read(dead.ctx, dead.tabs('a'))).toEqual({ contentBlocked: false })
  })

  it('pushes when a setting changes, and stops when asked', () => {
    const push = vi.fn()
    const stop = contentBlockedStatePart.watch?.(rig('https://a.example/').ctx, push) as () => void
    siteContentBlocks.changed()
    expect(push).toHaveBeenCalledTimes(1)
    stop()
    siteContentBlocks.changed()
    expect(push).toHaveBeenCalledTimes(1)
  })
})
