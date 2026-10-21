// When each app (an origin that holds grants) was last used, for the new tab's "Your apps" row. Pure functions over a
// plain value; `app-use-store.ts` keeps it on disk. Only origins that hold a grant are ever noted, so this is never a
// list of the sites a person visited.
import { sanitizeStoredFavicon } from '../browsing/bookmark-file.js'

export interface AppUse {
  /** Milliseconds since the epoch: the last time a tab on this origin was the one in front. */
  readonly usedAt: number
  /** The tab's icon as a `data:` URL, or null when the page had none. */
  readonly icon: string | null
}

export type AppUseState = Readonly<Record<string, AppUse>>

/** The origins remembered; the ones used longest ago go first. */
export const MAX_APPS_REMEMBERED = 32
/** A tab in front pushes its state many times a second; the app already newest is noted again once a minute. */
export const NOTE_AGAIN_MS = 60_000

const FILE_VERSION = 1
const MAX_ORIGIN_LENGTH = 2048

function newest (state: AppUseState): AppUseState {
  const entries = Object.entries(state)
  if (entries.length <= MAX_APPS_REMEMBERED) return state
  entries.sort(([, a], [, b]) => b.usedAt - a.usedAt)
  return Object.fromEntries(entries.slice(0, MAX_APPS_REMEMBERED))
}

/** `origin` was in front at `now`. The same state when there is nothing new to keep. */
export function noteUse (state: AppUseState, origin: string, icon: string | null, now: number): AppUseState {
  if (origin === '' || origin.length > MAX_ORIGIN_LENGTH) return state
  const before = state[origin]
  const safeIcon = sanitizeStoredFavicon(icon) ?? before?.icon ?? null
  // Only the app already newest is throttled: coming back to an older one within the minute is a change of order.
  const isNewest = before !== undefined && Object.values(state).every((use) => use.usedAt <= before.usedAt)
  if (before !== undefined && isNewest && safeIcon === before.icon && now >= before.usedAt && now - before.usedAt < NOTE_AGAIN_MS) return state
  return newest({ ...state, [origin]: { usedAt: now, icon: safeIcon } })
}

/** Forgets every use at or after `from`; 0 forgets all. */
export function forgetSince (state: AppUseState, from: number): AppUseState {
  const kept = Object.entries(state).filter(([, use]) => use.usedAt < from)
  return kept.length === Object.keys(state).length ? state : Object.fromEntries(kept)
}

/** The state out of a parsed file; anything this version did not write is dropped. */
export function parseUse (parsed: unknown): AppUseState {
  const record = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  const apps = record['apps']
  if (record['version'] !== FILE_VERSION || typeof apps !== 'object' || apps === null) return {}
  const state: Record<string, AppUse> = {}
  for (const [origin, value] of Object.entries(apps)) {
    const use = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
    if (origin === '' || origin.length > MAX_ORIGIN_LENGTH || typeof use['usedAt'] !== 'number' || !Number.isFinite(use['usedAt'])) continue
    state[origin] = { usedAt: use['usedAt'], icon: sanitizeStoredFavicon(use['icon']) }
  }
  return newest(state)
}

export function serializeUse (state: AppUseState): string {
  return JSON.stringify({ version: FILE_VERSION, apps: state }, null, 2)
}
