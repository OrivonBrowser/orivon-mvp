import { describe, expect, it, vi } from 'vitest'
import type { ShellWindow } from '../../shell/window-registry.js'
import { findStep, openFind } from '../find-commands.js'
import { createFindWindow } from '../find-window.js'
import type { OverlayWindow } from '../../overlays/overlay-types.js'

function target (options: { tab?: boolean, open?: boolean } = {}): { window: ShellWindow, show: ReturnType<typeof vi.fn> } {
  const show = vi.fn()
  const window = {
    tabs: { activeWebContents: () => options.tab === false ? undefined : {} },
    overlays: { show, isOpen: () => options.open === true }
  } as unknown as ShellWindow
  return { window, show }
}

describe('openFind', () => {
  it('shows the bar, which also takes focus back when it is open already', () => {
    const { window, show } = target({ open: true })

    openFind(window)

    expect(show).toHaveBeenCalledExactlyOnceWith('find')
  })

  it('does nothing without a page to search', () => {
    const { window, show } = target({ tab: false })

    openFind(window)
    findStep(window, true)

    expect(show).not.toHaveBeenCalled()
  })
})

describe('findStep', () => {
  it('opens the bar with the step while it is closed', () => {
    const { window, show } = target()

    findStep(window, false)

    expect(show).toHaveBeenCalledExactlyOnceWith('find', undefined, { step: false })
  })

  it('steps the open bar, and does not show it again', () => {
    const { window, show } = target({ open: true })
    const step = vi.fn()
    const active = { id: 'a', wc: { findInPage: vi.fn(), stopFindInPage: vi.fn(), isDestroyed: () => false } }
    Object.assign(window, {
      tabs: { activeWebContents: () => ({}), getState: () => ({ activeTabId: 'a' }), liveWebContents: () => active.wc, findTabIdByWebContents: () => 'a' },
      window: { isDestroyed: () => false }
    })
    const bar = createFindWindow({ window, services: { tabLifecycle: { subscribe: () => () => {} } }, send: vi.fn(), close: vi.fn() } as unknown as OverlayWindow)
    bar.step = step

    findStep(window, true)

    expect(step).toHaveBeenCalledExactlyOnceWith(true)
    expect(show).not.toHaveBeenCalled()
  })
})
