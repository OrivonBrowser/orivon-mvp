import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedSession } from '../../session-restore/session-types.js'
import { dismissRestoreOffer, OFFER_DELAY_MS, restoreOffer } from '../restore-offer.js'

const crashed: SavedSession = { version: 1, clean: false, windows: [{ bounds: { x: 0, y: 0, width: 800, height: 600 }, maximized: false, active: 0, tabs: [{ url: 'https://a.example/', title: '', pinned: false }] }] }

function setup (over: { mode?: string, previous?: SavedSession | null, isPrivate?: boolean } = {}) {
  const show = vi.fn()
  const closedHandlers: Array<() => void> = []
  const native = { isDestroyed: () => false, once: (_event: string, handler: () => void) => { closedHandlers.push(handler) } }
  const ctx = {
    window: { window: native, overlays: { show } },
    services: {
      settings: { get: () => over.mode ?? 'newTab' },
      session: { previous: () => ('previous' in over ? over.previous : crashed) },
      isPrivate: over.isPrivate ?? false
    }
  }
  return { ctx, show, closedHandlers }
}

describe('the crash offer', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('shows the bar a moment after the first window opens, not at once', () => {
    const { ctx, show } = setup()
    restoreOffer.opened?.(ctx as never, { firstOfLaunch: true })
    expect(show).not.toHaveBeenCalled()
    vi.advanceTimersByTime(OFFER_DELAY_MS)
    expect(show).toHaveBeenCalledWith('restore')
  })

  it('stays quiet for a later window, a clean end, the continue choice and a private session', () => {
    for (const [over, options] of [
      [{}, {}],
      [{}, { firstOfLaunch: false }],
      [{ previous: { ...crashed, clean: true } }, { firstOfLaunch: true }],
      [{ mode: 'continue' }, { firstOfLaunch: true }],
      [{ isPrivate: true }, { firstOfLaunch: true }],
      [{ previous: null }, { firstOfLaunch: true }]
    ] as const) {
      const { ctx, show } = setup(over)
      restoreOffer.opened?.(ctx as never, options)
      vi.advanceTimersByTime(OFFER_DELAY_MS * 2)
      expect(show).not.toHaveBeenCalled()
    }
  })

  it('does not show it in a window that closed first', () => {
    const { ctx, show, closedHandlers } = setup()
    restoreOffer.opened?.(ctx as never, { firstOfLaunch: true })
    closedHandlers.forEach((handler) => { handler() })
    vi.advanceTimersByTime(OFFER_DELAY_MS * 2)
    expect(show).not.toHaveBeenCalled()
  })

  it('steps aside for the find bar by closing its own overlay and no other', () => {
    const close = vi.fn()
    dismissRestoreOffer({ overlays: { close } })
    expect(close).toHaveBeenCalledExactlyOnceWith('restore')
  })
})
