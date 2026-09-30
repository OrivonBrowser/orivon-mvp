// The session file's shape and the one reader of it. Pure: a bad file is null, never a throw.
import { sanitizeSnapshot } from './tab-snapshot.js'
import type { TabSnapshot } from './tab-snapshot.js'

export const SESSION_VERSION = 1
export const MAX_SESSION_WINDOWS = 20
export const MAX_WINDOW_TABS = 100
/** A window's size and place are clamped to what a screen can hold. */
export const MIN_SIZE = 100
export const MAX_SIZE = 10_000
const MAX_OFFSET = 10_000

export interface WindowBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface SavedWindow {
  readonly bounds: WindowBounds
  readonly maximized: boolean
  /** Position, in `tabs`, of the tab that was in front. */
  readonly active: number
  readonly tabs: readonly TabSnapshot[]
}

export interface SavedSession {
  readonly version: typeof SESSION_VERSION
  /** False while the browser runs, true once it ended in an orderly way: a file that says false was left by a crash. */
  readonly clean: boolean
  readonly windows: readonly SavedWindow[]
}

function clampInt (value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function cleanBounds (raw: unknown): WindowBounds {
  const bounds = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  return {
    x: clampInt(bounds['x'], -MAX_OFFSET, MAX_OFFSET, 0),
    y: clampInt(bounds['y'], -MAX_OFFSET, MAX_OFFSET, 0),
    width: clampInt(bounds['width'], MIN_SIZE, MAX_SIZE, 1280),
    height: clampInt(bounds['height'], MIN_SIZE, MAX_SIZE, 800)
  }
}

/** One window as the rules allow it: a tab that fails `sanitizeSnapshot` is dropped, and `active` follows what is left. */
export function cleanWindow (raw: unknown): SavedWindow | null {
  if (typeof raw !== 'object' || raw === null) return null
  const source = raw as Record<string, unknown>
  if (!Array.isArray(source['tabs'])) return null
  const tabs: TabSnapshot[] = []
  let active = -1
  for (const [position, rawTab] of source['tabs'].slice(0, MAX_WINDOW_TABS).entries()) {
    const tab = sanitizeSnapshot(rawTab)
    if (tab === null) continue
    if (position === source['active']) active = tabs.length
    tabs.push(tab)
  }
  return { bounds: cleanBounds(source['bounds']), maximized: source['maximized'] === true, active: Math.max(0, active), tabs }
}

export function parseSession (text: string): SavedSession | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const file = parsed as Record<string, unknown>
  if (file['version'] !== SESSION_VERSION || !Array.isArray(file['windows'])) return null
  const windows: SavedWindow[] = []
  for (const raw of file['windows'].slice(0, MAX_SESSION_WINDOWS)) {
    const window = cleanWindow(raw)
    if (window !== null) windows.push(window)
  }
  return { version: SESSION_VERSION, clean: file['clean'] === true, windows }
}
