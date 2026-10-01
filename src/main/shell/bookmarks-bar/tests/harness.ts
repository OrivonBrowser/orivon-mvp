// A fake window and services around a real BookmarkStore, for the bookmarks bar's tests.
import { vi } from 'vitest'
import { BookmarkStore } from '../../../browsing/bookmarks.js'
import type { WindowContext } from '../../window-context.js'

export const tiny = 'data:image/png;base64,iVBORw0KGgo='

export interface Harness {
  ctx: WindowContext
  store: BookmarkStore
  tabs: { getState: ReturnType<typeof vi.fn>, navigate: ReturnType<typeof vi.fn>, createTab: ReturnType<typeof vi.fn>, ids: ReturnType<typeof vi.fn> }
  overlays: { isOpen: ReturnType<typeof vi.fn>, show: ReturnType<typeof vi.fn>, close: ReturnType<typeof vi.fn> }
  commands: { run: ReturnType<typeof vi.fn>, openWindow: ReturnType<typeof vi.fn> }
  openPrivate: ReturnType<typeof vi.fn>
  settings: { get: ReturnType<typeof vi.fn>, set: ReturnType<typeof vi.fn> }
  newWindowTabs: { createTab: ReturnType<typeof vi.fn> }
}

export function harness (options: { isPrivate?: boolean, active?: string | null, capacity?: number } = {}): Harness {
  const store = new BookmarkStore('/nowhere/bookmarks.json', (() => { let n = 0; return () => `id${String(n++)}` })(), () => 1)
  const open: string[] = ['a']
  const capacity = options.capacity ?? 100
  const tabs = {
    getState: vi.fn(() => ({ tabs: [], activeTabId: options.active === undefined ? 'a' : options.active })),
    navigate: vi.fn(),
    createTab: vi.fn(() => { if (open.length < capacity) open.push('x') }),
    ids: vi.fn(() => open)
  }
  const overlays = { isOpen: vi.fn(() => false), show: vi.fn(), close: vi.fn() }
  const newWindowTabs = { createTab: vi.fn() }
  const commands = {
    run: vi.fn(),
    openWindow: vi.fn((opened: { first?: (tabs: typeof newWindowTabs) => void }) => { opened.first?.(newWindowTabs) })
  }
  const openPrivate = vi.fn(() => true)
  const settings = { get: vi.fn(() => 'auto'), set: vi.fn() }
  const services = { bookmarks: store, commands, profiles: { openPrivate }, isPrivate: options.isPrivate === true, settings }
  const window = { tabs, overlays, window: { isDestroyed: () => false } }
  return { ctx: { window, services } as unknown as WindowContext, store, tabs, overlays, commands, openPrivate, settings, newWindowTabs }
}
