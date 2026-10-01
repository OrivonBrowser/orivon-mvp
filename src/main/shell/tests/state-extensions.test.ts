import { describe, expect, it, vi } from 'vitest'
import { SHELL_STATE_PARTS } from '../shell-state-parts.js'
import { extensionsButtonShown, extensionsStatePart } from '../state/extensions.js'
import type { WindowContext } from '../window-context.js'

function context (init: { mode: string, enabled: number, isPrivate?: boolean }): { ctx: WindowContext, change: (key: string) => void, loadedChange: () => void, removed: ReturnType<typeof vi.fn> } {
  let settingListener: (change: { key: string }) => void = () => {}
  let loadedListener: () => void = () => {}
  const removed = vi.fn()
  const services = {
    isPrivate: init.isPrivate === true,
    settings: { get: (key: string) => (key === 'toolbar.extensions' ? init.mode : undefined), onChange: (next: typeof settingListener) => { settingListener = next; return removed } },
    extensionsLoaded: { count: () => init.enabled, onChange: (next: () => void) => { loadedListener = next; return removed } }
  }
  return { ctx: { services } as unknown as WindowContext, change: (key) => { settingListener({ key }) }, loadedChange: () => { loadedListener() }, removed }
}

const tabs = { tabs: [], activeTabId: null }

describe('extensionsButtonShown', () => {
  it('shows with at least one extension in auto, always in always, never in never', () => {
    expect(extensionsButtonShown('auto', 0, false)).toBe(false)
    expect(extensionsButtonShown('auto', 1, false)).toBe(true)
    expect(extensionsButtonShown('always', 0, false)).toBe(true)
    expect(extensionsButtonShown('never', 3, false)).toBe(false)
  })

  it('never shows in a private window, whatever the setting says', () => {
    for (const mode of ['auto', 'always', 'never'] as const) expect(extensionsButtonShown(mode, 2, true)).toBe(false)
  })
})

describe('the extensions state part', () => {
  it('is registered', () => {
    expect(SHELL_STATE_PARTS).toContain(extensionsStatePart)
  })

  it('reads how many are loaded and whether the button shows', () => {
    expect(extensionsStatePart.read(context({ mode: 'auto', enabled: 2 }).ctx, tabs)).toEqual({ extensions: { enabled: 2, shown: true } })
    expect(extensionsStatePart.read(context({ mode: 'auto', enabled: 0 }).ctx, tabs)).toEqual({ extensions: { enabled: 0, shown: false } })
    expect(extensionsStatePart.read(context({ mode: 'always', enabled: 0, isPrivate: true }).ctx, tabs)).toEqual({ extensions: { enabled: 0, shown: false } })
  })

  it('pushes when that setting changes, when an extension loads or unloads, and for nothing else', () => {
    const { ctx, change, loadedChange, removed } = context({ mode: 'auto', enabled: 0 })
    const push = vi.fn()
    const stop = extensionsStatePart.watch?.(ctx, push)
    change('toolbar.home')
    expect(push).not.toHaveBeenCalled()
    change('toolbar.extensions')
    loadedChange()
    expect(push).toHaveBeenCalledTimes(2)
    stop?.()
    expect(removed).toHaveBeenCalledTimes(2)
  })
})
