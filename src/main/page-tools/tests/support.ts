// Fakes the page-tool tests share: a window that records its toasts, and the dependencies with no machine behind them.
import { vi } from 'vitest'
import type { ShellWindow } from '../../shell/window-registry.js'
import type { PageToolDeps } from '../deps.js'

export function fakeWindow (extra: Record<string, unknown> = {}): { window: ShellWindow, show: ReturnType<typeof vi.fn>, toasts: () => string[] } {
  const show = vi.fn()
  const window = { window: { isDestroyed: () => false }, overlays: { show, toggle: vi.fn(), close: vi.fn() }, ...extra } as unknown as ShellWindow
  return { window, show, toasts: () => show.mock.calls.filter((call) => call[0] === 'toast').map((call) => (call[2] as { code: string }).code) }
}

export function fakeDeps (chosen: string | null = '/out/file'): PageToolDeps & { files: Map<string, Uint8Array>, pickSave: ReturnType<typeof vi.fn>, copyImage: ReturnType<typeof vi.fn> } {
  const files = new Map<string, Uint8Array>()
  return {
    files,
    pickSave: vi.fn(async () => chosen ?? undefined),
    downloadsDir: () => '/home/me/Downloads',
    writeFile: async (path, data) => { files.set(path, data) },
    rename: async (from, to) => { const data = files.get(from); if (data !== undefined) { files.set(to, data); files.delete(from) } },
    remove: async (path) => { files.delete(path) },
    reveal: () => {},
    copyImage: vi.fn(async () => {}),
    now: () => new Date(2026, 8, 30, 14, 5, 9),
    wait: async () => {}
  }
}
