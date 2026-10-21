// The new tab's "Your apps" row: the origins that hold a grant, newest use first. The ordering is pure; the service
// joins it to the broker's list of granted apps and notes which one is in front.
import { originFromUrl } from '../../broker/policy/origin.js'
import type { AppUseStore } from './app-use-store.js'
import type { AppUseState } from './app-use-state.js'

/** The row holds one line of tiles; the Settings page lists the rest. */
export const YOUR_APPS_TILES = 8

/** An origin that holds at least one grant, with the name its manifest gave (the origin itself when it gave none). */
export interface GrantedApp {
  readonly origin: string
  readonly name: string
}

export interface YourAppTile {
  readonly origin: string
  readonly name: string
  readonly icon: string | null
}

/** What the page needs to draw the row. `isPrivate` lets it leave the row out of a private window that has no grants of its own. */
export interface YourAppsAnswer {
  readonly apps: readonly YourAppTile[]
  readonly isPrivate: boolean
}

function nameOf (app: GrantedApp): string {
  if (app.name.trim() !== '' && app.name !== app.origin) return app.name
  try {
    return new URL(app.origin).host || app.origin
  } catch {
    return app.origin
  }
}

/** Apps used before come first, the most recent first; the rest follow by name. At most `max` tiles. */
export function yourAppsTiles (granted: readonly GrantedApp[], use: AppUseState, max: number = YOUR_APPS_TILES): YourAppTile[] {
  const seen = new Set<string>()
  const tiles = granted.flatMap((app): Array<YourAppTile & { usedAt: number | null }> => {
    if (seen.has(app.origin)) return []
    seen.add(app.origin)
    const used = use[app.origin]
    return [{ origin: app.origin, name: nameOf(app), icon: used?.icon ?? null, usedAt: used?.usedAt ?? null }]
  })
  tiles.sort((a, b) => {
    if (a.usedAt !== null && b.usedAt !== null && a.usedAt !== b.usedAt) return b.usedAt - a.usedAt
    if ((a.usedAt === null) !== (b.usedAt === null)) return a.usedAt === null ? 1 : -1
    return a.name.localeCompare(b.name) || a.origin.localeCompare(b.origin)
  })
  return tiles.slice(0, max).map(({ origin, name, icon }) => ({ origin, name, icon }))
}

export interface YourAppsDeps {
  readonly store: AppUseStore
  /** Every origin that holds a grant now, loaded this session or kept on disk. */
  readonly granted: () => Promise<readonly GrantedApp[]>
  /** Whether the origin of a page holds a grant now. */
  readonly holdsGrant: (url: string) => boolean
  readonly isPrivate: boolean
  readonly now?: () => number
}

export interface YourApps {
  list: () => Promise<YourAppsAnswer>
  /** The page in front of the person; only a granted origin is noted. */
  noteInFront: (tab: { readonly url: string, readonly favicon: string | null }) => void
}

export function createYourApps (deps: YourAppsDeps): YourApps {
  const now = deps.now ?? Date.now
  return {
    async list () {
      try {
        return { apps: yourAppsTiles(await deps.granted(), deps.store.get()), isPrivate: deps.isPrivate }
      } catch (error) {
        console.error('[orivon] the new tab could not list the granted apps:', error)
        return { apps: [], isPrivate: deps.isPrivate }
      }
    },
    noteInFront (tab) {
      const origin = originFromUrl(tab.url)
      if (origin === null || !deps.holdsGrant(tab.url)) return
      deps.store.note(origin, tab.favicon, now())
    }
  }
}
