import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedSession } from '../../session-restore/session-types.js'
import { setCrashLookups } from '../../diagnostics/crash-lookup.js'
import { dismissRestoreOffer, OFFER_DELAY_MS, restoreOffer } from '../restore-offer.js'

const crashed: SavedSession = { version: 1, clean: false, windows: [{ bounds: { x: 0, y: 0, width: 800, height: 600 }, maximized: false, active: 0, tabs: [{ url: 'https://a.example/', title: '', pinned: false }] }] }

function setup (over: { mode?: string, previous?: SavedSession | null, isPrivate?: boolean, kiosk?: boolean } = {}) {
  const show = vi.fn()
  const closedHandlers: Array<() => void> = []
  const native = { isDestroyed: () => false, once: (_event: string, handler: () => void) => { closedHandlers.push(handler) } }
  const ctx = {
    window: { window: native, overlays: { show } },
    services: {
      settings: { get: () => over.mode ?? 'newTab' },
      session: { previous: () => ('previous' in over ? over.previous : crashed) },
      isPrivate: over.isPrivate ?? false,
      kiosk: over.kiosk ?? false
    }
  }
  return { ctx, show, closedHandlers }
}

describe('the crash offer', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); setCrashLookups({ page: () => undefined, lastRun: () => undefined }) })

  it('shows the bar a moment after the first window opens, not at once', () => {
    const { ctx, show } = setup()
    restoreOffer.opened?.(ctx as never, { firstOfLaunch: true })
    expect(show).not.toHaveBeenCalled()
    vi.advanceTimersByTime(OFFER_DELAY_MS)
    expect(show).toHaveBeenCalledWith('restore', undefined, { restore: true, report: false })
  })

  it('stays quiet for a later window, a clean end, the continue choice, a private session and a kiosk', () => {
    for (const [over, options] of [
      [{}, {}],
      [{}, { firstOfLaunch: false }],
      [{ previous: { ...crashed, clean: true } }, { firstOfLaunch: true }],
      [{ mode: 'continue' }, { firstOfLaunch: true }],
      [{ isPrivate: true }, { firstOfLaunch: true }],
      [{ kiosk: true }, { firstOfLaunch: true }],
      [{ previous: null }, { firstOfLaunch: true }]
    ] as const) {
      const { ctx, show } = setup(over)
      restoreOffer.opened?.(ctx as never, options)
      vi.advanceTimersByTime(OFFER_DELAY_MS * 2)
      expect(show).not.toHaveBeenCalled()
    }
  })

  it('offers the report with the restore when the last run left a crash to report', () => {
    setCrashLookups({ page: () => undefined, lastRun: () => '0123456789abcdef' })
    const { ctx, show } = setup()
    restoreOffer.opened?.(ctx as never, { firstOfLaunch: true })
    vi.advanceTimersByTime(OFFER_DELAY_MS)
    expect(show).toHaveBeenCalledWith('restore', undefined, { restore: true, report: true })
  })

  it('offers only the report when the start-up choice already reopened the session, or the run ended in an orderly way', () => {
    setCrashLookups({ page: () => undefined, lastRun: () => '0123456789abcdef' })
    for (const over of [{ mode: 'continue' }, { previous: { ...crashed, clean: true } }, { previous: null }]) {
      const { ctx, show } = setup(over)
      restoreOffer.opened?.(ctx as never, { firstOfLaunch: true })
      vi.advanceTimersByTime(OFFER_DELAY_MS)
      expect(show).toHaveBeenCalledWith('restore', undefined, { restore: false, report: true })
    }
  })

  it('never offers the report in a private session, to a kiosk or in a later window', () => {
    setCrashLookups({ page: () => undefined, lastRun: () => '0123456789abcdef' })
    for (const [over, options] of [[{ isPrivate: true }, { firstOfLaunch: true }], [{ kiosk: true }, { firstOfLaunch: true }], [{}, { firstOfLaunch: false }]] as const) {
      const { ctx, show } = setup({ ...over, previous: null })
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
