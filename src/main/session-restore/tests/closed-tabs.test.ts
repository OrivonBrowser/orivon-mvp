import { describe, expect, it } from 'vitest'
import type { BaseWindow } from 'electron'
import { TabLifecycle } from '../../shell/tab-lifecycle.js'
import type { TabClosingReason } from '../../shell/tab-lifecycle.js'
import type { TabRecord } from '../../shell/tab-types.js'
import { ClosedStack } from '../closed-stack.js'
import { watchClosedTabs } from '../closed-tabs.js'

const record = { view: { webContents: {} } } as unknown as TabRecord

function closing (lifecycle: TabLifecycle, reason: TabClosingReason, window: BaseWindow | undefined = { id: 7 } as BaseWindow): void {
  lifecycle.tabClosing({ id: 'tab-1', index: 3, record, reason, window })
}

describe('watchClosedTabs', () => {
  const setup = (): { lifecycle: TabLifecycle, stack: ClosedStack } => {
    const lifecycle = new TabLifecycle()
    const stack = new ClosedStack()
    watchClosedTabs(lifecycle, stack, () => ({ url: 'https://a.example/', title: 'A', pinned: true }))
    return { lifecycle, stack }
  }

  it('pushes a tab the person closed, with its place and its window', () => {
    const { lifecycle, stack } = setup()
    closing(lifecycle, 'closed')
    expect(stack.list()).toEqual([expect.objectContaining({ kind: 'tab', index: 3, windowKey: 7, tab: { url: 'https://a.example/', title: 'A', pinned: true } })])
  })

  it('pushes nothing for a tab that moved, crashed away or went with its window', () => {
    const { lifecycle, stack } = setup()
    for (const reason of ['moved', 'gone', 'window-closing'] as const) closing(lifecycle, reason)
    expect(stack.size).toBe(0)
  })

  it('pushes nothing for a tab that is not worth bringing back', () => {
    const lifecycle = new TabLifecycle()
    const stack = new ClosedStack()
    watchClosedTabs(lifecycle, stack, () => null)
    closing(lifecycle, 'closed')
    expect(stack.size).toBe(0)
  })

  it('stops when removed', () => {
    const lifecycle = new TabLifecycle()
    const stack = new ClosedStack()
    const off = watchClosedTabs(lifecycle, stack, () => ({ url: 'https://a.example/', title: '', pinned: false }))
    off()
    closing(lifecycle, 'closed')
    expect(stack.size).toBe(0)
  })
})

describe('watchClosedTabs and groups', () => {
  it('keeps the group a closed tab was in, and none for a tab that was in no group', () => {
    const lifecycle = new TabLifecycle()
    const stack = new ClosedStack()
    watchClosedTabs(lifecycle, stack, () => ({ url: 'https://a.example/', title: 'A', pinned: false }))
    lifecycle.tabClosing({ id: 'tab-1', index: 0, record: { view: { webContents: {} }, groupId: 'g-4' } as unknown as TabRecord, reason: 'closed', window: undefined })
    lifecycle.tabClosing({ id: 'tab-2', index: 0, record: { view: { webContents: {} }, groupId: null } as unknown as TabRecord, reason: 'closed', window: undefined })
    const [none, grouped] = stack.list()
    expect(grouped).toMatchObject({ groupId: 'g-4' })
    expect(none).not.toHaveProperty('groupId')
  })
})

