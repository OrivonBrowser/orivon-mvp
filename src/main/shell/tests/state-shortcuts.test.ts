import { describe, expect, it, vi } from 'vitest'
import { SHELL_STATE_PARTS } from '../shell-state-parts.js'
import { shortcutsStatePart } from '../state/shortcuts.js'
import type { WindowContext } from '../window-context.js'

function context (bound: Record<string, string[] | null>): { ctx: WindowContext, change: () => void, removed: ReturnType<typeof vi.fn> } {
  let listener: () => void = () => {}
  const removed = vi.fn()
  const shortcuts = {
    keysOf: (id: string) => bound[id] ?? null,
    onChange: (next: () => void) => { listener = next; return removed }
  }
  return { ctx: { services: { shortcuts } } as unknown as WindowContext, change: () => { listener() }, removed }
}

describe('the shortcuts state part', () => {
  it('is registered', () => {
    expect(SHELL_STATE_PARTS).toContain(shortcutsStatePart)
  })

  it('reads the keys bound to the commands the chrome names in a tooltip', () => {
    const tabs = { tabs: [], activeTabId: null }
    const { ctx } = context({ 'nav.home': ['Alt', 'Home'], 'sidePanel.toggle': ['Ctrl', 'Alt', 'B'], 'tab.search': null })
    expect(shortcutsStatePart.read(ctx, tabs)).toEqual({ shortcutKeys: { 'nav.home': ['Alt', 'Home'], 'sidePanel.toggle': ['Ctrl', 'Alt', 'B'], 'tab.search': null } })
  })

  it('pushes when a binding changes, and stops with the window', () => {
    const { ctx, change, removed } = context({})
    const push = vi.fn()
    const stop = shortcutsStatePart.watch?.(ctx, push)
    change()
    expect(push).toHaveBeenCalledTimes(1)
    stop?.()
    expect(removed).toHaveBeenCalled()
  })
})
