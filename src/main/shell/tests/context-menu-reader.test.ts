import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONTEXT, pageGroup } from '../context-menu-groups.js'
import type { ContextMenuActions } from '../context-menu-groups.js'

const labels = (actions: ContextMenuActions, context = DEFAULT_CONTEXT): string[] => pageGroup(actions, context).map((item) => item.label ?? '-')

function actions (): ContextMenuActions {
  return { navigate: { canGoBack: false, canGoForward: false, back: vi.fn(), forward: vi.fn(), reload: vi.fn() }, run: vi.fn() } as unknown as ContextMenuActions
}

describe('Open in Reader View', () => {
  it('is offered only on a page that looks like an article', () => {
    expect(labels(actions())).not.toContain('Open in Reader View')
    expect(labels(actions(), { ...DEFAULT_CONTEXT, readable: true })).toContain('Open in Reader View')
  })

  it('is not offered on a shell page, whatever the page says', () => {
    expect(labels(actions(), { ...DEFAULT_CONTEXT, readable: true, bare: true })).not.toContain('Open in Reader View')
  })

  it('runs the reader command', () => {
    const own = actions()
    const item = pageGroup(own, { ...DEFAULT_CONTEXT, readable: true }).find((entry) => entry.label === 'Open in Reader View')
    ;(item?.click as () => void)()
    expect(own.run).toHaveBeenCalledWith('page.reader')
  })
})
