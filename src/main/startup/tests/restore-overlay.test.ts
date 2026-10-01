import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClosedStack } from '../../session-restore/closed-stack.js'
import type { SavedSession, SavedWindow } from '../../session-restore/session-types.js'
import { OFFER_SHOWN_MS, restoreOverlayFor } from '../restore-overlay.js'

const window = (url: string): SavedWindow => ({ bounds: { x: 10, y: 10, width: 800, height: 600 }, maximized: false, active: 0, tabs: [{ url, title: '', pinned: false }] })
const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } }

function setup (previous: SavedSession | null) {
  const closedTabs = new ClosedStack()
  for (const saved of previous?.windows ?? []) closedTabs.push({ kind: 'window', window: saved })
  const openWindow = vi.fn()
  const close = vi.fn()
  const overlay = restoreOverlayFor({ displays: () => [display] })
  const handler = overlay.attach({ services: { session: { previous: () => previous }, closedTabs, commands: { openWindow }, shortcuts: { keysOf: () => ['Ctrl', 'Shift', 'T'] } }, close } as never)
  return { overlay, handler, openWindow, close, closedTabs }
}

describe('the restore overlay', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const previous: SavedSession = { version: 1, clean: false, windows: [window('https://a.example/'), window('https://b.example/')] }

  it('is a bar that never takes focus and stays over a tab switch', () => {
    const { overlay } = setup(previous)
    expect(overlay).toMatchObject({ name: 'restore', focus: 'never', layer: 'bar', keep: 'fresh', placement: { kind: 'area', at: 'top-center', width: 420 } })
    expect(overlay.closeOn).toEqual({ blur: false, tabSwitch: false, navigation: false, layout: false })
  })

  it('opens the previous windows and takes them off the closed stack on Restore', () => {
    const { handler, openWindow, close, closedTabs } = setup(previous)
    handler.request({ type: 'restore' })
    expect(close).toHaveBeenCalledTimes(1)
    expect(openWindow).toHaveBeenCalledTimes(2)
    expect(openWindow.mock.calls[0]?.[0]).toMatchObject({ place: { x: 10, y: 10, width: 800, height: 600 }, maximized: false })
    expect(closedTabs.size).toBe(0)
  })

  it('does not open again a window that Reopen already brought back', () => {
    const { handler, openWindow, closedTabs } = setup(previous)
    closedTabs.pop()
    handler.request({ type: 'restore' })
    expect(openWindow).toHaveBeenCalledTimes(1)
    expect(openWindow.mock.calls[0]?.[0]).toMatchObject({ place: { x: 10 } })
  })

  it('tells the page the keys that do the same from the keyboard', () => {
    const { handler } = setup(previous)
    expect(handler.show?.(undefined)).toEqual({ keys: ['Ctrl', 'Shift', 'T'] })
  })

  it('restores once, however often it is asked', () => {
    const { handler, openWindow } = setup(previous)
    handler.request({ type: 'restore' })
    handler.request({ type: 'restore' })
    expect(openWindow).toHaveBeenCalledTimes(2)
  })

  it('closes and opens nothing on Dismiss, leaving the windows for Reopen', () => {
    const { handler, openWindow, close, closedTabs } = setup(previous)
    handler.request({ type: 'dismiss' })
    expect(close).toHaveBeenCalledTimes(1)
    expect(openWindow).not.toHaveBeenCalled()
    expect(closedTabs.size).toBe(2)
  })

  it('does nothing for any other command', () => {
    const { handler, openWindow, close } = setup(previous)
    for (const command of [undefined, null, 'restore', 7, {}, { type: 'open' }, { type: 'restore ' }, { type: { restore: true } }, []]) handler.request(command)
    expect(openWindow).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('goes away by itself after thirty seconds, and not before', () => {
    const { handler, close } = setup(previous)
    handler.show?.(undefined)
    vi.advanceTimersByTime(OFFER_SHOWN_MS - 1)
    expect(close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('stops its timer when it is closed', () => {
    const { handler, close } = setup(previous)
    handler.show?.(undefined)
    handler.closed?.('request')
    vi.advanceTimersByTime(OFFER_SHOWN_MS * 2)
    expect(close).not.toHaveBeenCalled()
  })
})
