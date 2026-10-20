// What the "Your apps" row shows. Pure, so the empty state and the private-window rule run under plain vitest.

export const YOUR_APPS_EMPTY = 'Apps you allow appear here'

export interface YourAppTile {
  readonly origin: string
  readonly name: string
  /** A `data:` URL, or null for the globe. */
  readonly icon: string | null
}

export interface YourAppsAnswer {
  readonly apps: readonly YourAppTile[]
  readonly isPrivate: boolean
}

export const NO_YOUR_APPS: YourAppsAnswer = { apps: [], isPrivate: false }

/** The answer out of what main sent; anything else is no apps, so a page never fails to draw. */
export function readYourApps (answer: unknown): YourAppsAnswer {
  if (typeof answer !== 'object' || answer === null) return NO_YOUR_APPS
  const { apps, isPrivate } = answer as Record<string, unknown>
  const tiles = Array.isArray(apps)
    ? (apps as unknown[]).flatMap((item): YourAppTile[] => {
        if (typeof item !== 'object' || item === null) return []
        const { origin, name, icon } = item as Record<string, unknown>
        if (typeof origin !== 'string' || origin === '' || typeof name !== 'string') return []
        return [{ origin, name: name === '' ? origin : name, icon: typeof icon === 'string' && icon.startsWith('data:image/') ? icon : null }]
      })
    : []
  return { apps: tiles, isPrivate: isPrivate === true }
}

export interface YourAppsView {
  readonly shown: boolean
  readonly tiles: readonly YourAppTile[]
  /** The line drawn in place of tiles, or null when there are tiles. */
  readonly empty: string | null
}

/** A private window has no row until it holds grants of its own; anywhere else the row is always there, saying what it is for when it is empty. */
export function yourAppsView (answer: YourAppsAnswer): YourAppsView {
  if (answer.apps.length === 0) return { shown: !answer.isPrivate, tiles: [], empty: YOUR_APPS_EMPTY }
  return { shown: true, tiles: answer.apps, empty: null }
}
