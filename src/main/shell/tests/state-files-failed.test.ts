import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { failedFiles } from '../../verifier/failed-files-store.js'
import { SHELL_STATE_PARTS } from '../shell-state-parts.js'
import { filesFailedStatePart } from '../state/files-failed.js'
import type { TabsSnapshot } from '../tab-types.js'
import type { WindowContext } from '../window-context.js'

function rig () {
  const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents
  const ctx = { window: { tabs: { liveWebContents: (id: string) => id === 'a' ? wc : undefined } } } as unknown as WindowContext
  const tabs = (activeTabId: string | null): TabsSnapshot => ({ activeTabId }) as unknown as TabsSnapshot
  return { wc, ctx, tabs }
}

describe('the files-failed state part', () => {
  it('is one of the window state parts', () => {
    expect(SHELL_STATE_PARTS.map((part) => part.name)).toContain('filesFailed')
  })

  it('counts the files the active page asked for and did not get, and zero for a tab with none or no live contents', () => {
    const { wc, ctx, tabs } = rig()
    expect(filesFailedStatePart.read(ctx, tabs('a'))).toEqual({ filesFailed: 0 })
    failedFiles.add(wc, 'https://x.eth/app.css')
    expect(filesFailedStatePart.read(ctx, tabs('a'))).toEqual({ filesFailed: 1 })
    expect(filesFailedStatePart.read(ctx, tabs('gone'))).toEqual({ filesFailed: 0 })
    expect(filesFailedStatePart.read(ctx, tabs(null))).toEqual({ filesFailed: 0 })
  })

  it('pushes when a record changes, and stops when asked', () => {
    const { wc, ctx } = rig()
    const push = vi.fn()
    const stop = filesFailedStatePart.watch?.(ctx, push) as () => void
    failedFiles.add(wc, 'https://x.eth/a.js')
    expect(push).toHaveBeenCalledTimes(1)
    stop()
    failedFiles.add(wc, 'https://x.eth/b.js')
    expect(push).toHaveBeenCalledTimes(1)
  })
})
