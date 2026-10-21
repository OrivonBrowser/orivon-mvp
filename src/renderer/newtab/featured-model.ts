// What the "Orivon Featured" row shows: the entries the build ships, and the choices this profile made about them.
// Pure, so the order and the pin rules run under plain vitest; `featured.ts` adds the icons, `main.ts` the page.

export interface FeaturedEntry {
  /** A lowercase slug, stable across releases; the name label of the app's `.orivonstack.eth` address. */
  readonly id: string
  readonly name: string
  readonly url: string
  /** A file in `featured/`; null draws a letter. */
  readonly icon: string | null
  /** Shown before the rest, in `order`. */
  readonly pinned: boolean
  readonly order: number
  /** Set by hand while the app lags a security or funds fix upstream; the data test refuses an entry that has it. */
  readonly hold?: { readonly reason: string }
}

/** What main keeps for this profile (`src/main/newtab/featured-prefs.ts` writes it). */
export interface FeaturedPrefs {
  /** The app a new profile was given first in the row, or null once the person removed it or none was given. */
  readonly newcomerPin: string | null
  /** What the pinned app's tile says when the app is not among the shipped entries. */
  readonly newcomerName?: string | null
  /** Entries the person unpinned, whatever the data says. */
  readonly unpinned: readonly string[]
  readonly hidden: readonly string[]
}

/** The prefs out of what main answered; anything else is none, so a page never fails to draw the row. */
export function readPrefs (answer: unknown): FeaturedPrefs {
  if (typeof answer !== 'object' || answer === null) return NO_PREFS
  const { newcomerPin, newcomerName, unpinned, hidden } = answer as Record<string, unknown>
  const keys = (value: unknown): string[] => Array.isArray(value) ? (value as unknown[]).filter((item): item is string => typeof item === 'string') : []
  return { newcomerPin: typeof newcomerPin === 'string' ? newcomerPin : null, newcomerName: typeof newcomerName === 'string' ? newcomerName : null, unpinned: keys(unpinned), hidden: keys(hidden) }
}

export interface FeaturedTile {
  readonly id: string
  readonly name: string
  readonly url: string
  readonly icon: string | null
  readonly pinned: boolean
}

export const NO_PREFS: FeaturedPrefs = { newcomerPin: null, unpinned: [], hidden: [] }

const ORIVON_NAME = /^ipfs:\/\/([a-z0-9-]+)\.orivonstack\.eth\/?$/
const SLUG = /^[a-z0-9-]+$/

/** The tile for a pin that is not in the shipped set. An id, or an `ipfs://<id>.orivonstack.eth` address, gets that name's label as its name; any other address its host. Null when the text is neither. */
export function tileForOutsider (key: string, name?: string | null): FeaturedTile | null {
  const label = SLUG.test(key) ? key : ORIVON_NAME.exec(key)?.[1]
  if (label !== undefined) return { id: label, name: name ?? label, url: `ipfs://${label}.orivonstack.eth`, icon: null, pinned: true }
  try {
    const url = new URL(key)
    return { id: key, name: name ?? url.host, url: key, icon: null, pinned: true }
  } catch {
    return null
  }
}

function byOrder (a: FeaturedEntry, b: FeaturedEntry): number {
  return a.order - b.order
}

/** The row, in order: the newcomer's pin, then pinned entries by `order`, then the rest by `order`; hidden entries left out. `hiddenCount` is how many shipped entries the person hid. */
export function featuredRow (entries: readonly FeaturedEntry[], prefs: FeaturedPrefs): { tiles: FeaturedTile[], hiddenCount: number } {
  const isPinned = (entry: FeaturedEntry): boolean => entry.pinned && !prefs.unpinned.includes(entry.id)
  const sorted = [...entries].sort(byOrder)
  const shown = sorted.filter((entry) => !prefs.hidden.includes(entry.id))
  const ordered = [...shown.filter(isPinned), ...shown.filter((entry) => !isPinned(entry))]
  const tiles: FeaturedTile[] = ordered.map((entry) => ({ id: entry.id, name: entry.name, url: entry.url, icon: entry.icon, pinned: isPinned(entry) }))
  const pin = prefs.newcomerPin
  if (pin !== null && !prefs.hidden.includes(pin)) {
    const at = tiles.findIndex((tile) => tile.id === pin || tile.url === pin)
    const found = at === -1 ? tileForOutsider(pin, prefs.newcomerName) : { ...(tiles.splice(at, 1)[0] as FeaturedTile), pinned: true }
    if (found !== null) tiles.unshift(found)
  }
  return { tiles, hiddenCount: sorted.length - shown.length }
}

/** The problems with a shipped entry list; empty when it is sound. `iconExists` answers for a file in `featured/`. */
export function featuredProblems (entries: readonly FeaturedEntry[], iconExists: (file: string) => boolean): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!SLUG.test(entry.id)) problems.push(`${entry.id}: the id is not a lowercase slug`)
    if (seen.has(entry.id)) problems.push(`${entry.id}: the id is used twice`)
    seen.add(entry.id)
    if (ORIVON_NAME.exec(entry.url)?.[1] !== entry.id) problems.push(`${entry.id}: the url is not ipfs://${entry.id}.orivonstack.eth`)
    if (entry.name.trim() === '') problems.push(`${entry.id}: the name is empty`)
    if (entry.icon !== null && !iconExists(entry.icon)) problems.push(`${entry.id}: the icon ${entry.icon} is not in featured/`)
    if (!Number.isFinite(entry.order)) problems.push(`${entry.id}: the order is not a number`)
  }
  return problems
}

/** The entries marked as lagging a security or funds fix, each with its reason. The shipped list must have none: CI fails on one until the port catches up or the entry leaves. */
export function heldEntries (entries: readonly FeaturedEntry[]): string[] {
  return entries.flatMap((entry) => entry.hold === undefined ? [] : [`${entry.id}: ${entry.hold.reason}`])
}
