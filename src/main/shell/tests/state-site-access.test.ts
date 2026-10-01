import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { pageAccess } from '../../site-settings/page-access.js'
import { SHELL_STATE_PARTS } from '../shell-state-parts.js'
import { siteAccessStatePart } from '../state/site-access.js'
import type { TabsSnapshot } from '../tab-types.js'
import type { WindowContext } from '../window-context.js'

const SITE = 'https://meet.example'

function rig () {
  const wc = new EventEmitter() as unknown as WebContents
  const ctx = { window: { tabs: { liveWebContents: (id: string) => id === 'a' ? wc : undefined } } } as unknown as WindowContext
  const tabs = (activeTabId: string | null): TabsSnapshot => ({ activeTabId }) as unknown as TabsSnapshot
  return { wc, ctx, tabs }
}

describe('the site-access state part', () => {
  it('is one of the window state parts', () => {
    expect(SHELL_STATE_PARTS.map((part) => part.name)).toContain('siteAccess')
  })

  it('reports what the active page was asked, blocked or allowed, with the kind\'s label', () => {
    const { wc, ctx, tabs } = rig()
    pageAccess.note(wc, SITE, 'camera', 'blocked')
    pageAccess.note(wc, SITE, 'location', 'allowed')
    expect(siteAccessStatePart.read(ctx, tabs('a'))).toEqual({
      siteAccess: [{ kind: 'camera', state: 'blocked', label: 'Camera' }, { kind: 'location', state: 'allowed', label: 'Location' }]
    })
  })

  it('reports nothing for a page that was not asked, a tab with no live contents, or no active tab', () => {
    const { ctx, tabs } = rig()
    expect(siteAccessStatePart.read(ctx, tabs('a'))).toEqual({ siteAccess: [] })
    expect(siteAccessStatePart.read(ctx, tabs('gone'))).toEqual({ siteAccess: [] })
    expect(siteAccessStatePart.read(ctx, tabs(null))).toEqual({ siteAccess: [] })
  })

  it('pushes when a page\'s record changes, and stops when asked', () => {
    const { wc, ctx } = rig()
    const push = vi.fn()
    const stop = siteAccessStatePart.watch?.(ctx, push) as () => void
    pageAccess.note(wc, SITE, 'camera', 'allowed')
    expect(push).toHaveBeenCalledTimes(1)
    stop()
    pageAccess.note(wc, SITE, 'location', 'allowed')
    expect(push).toHaveBeenCalledTimes(1)
  })
})
