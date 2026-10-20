// The entries of "Orivon Featured", read from `featured/featured.json`. The icons are in `featured/`, with their
// sources in that folder's README.
import type { FeaturedEntry } from './featured-model.js'
import shipped from './featured/featured.json'

export const FEATURED: readonly FeaturedEntry[] = shipped as FeaturedEntry[]

/** The URL the build serves an entry's icon file at, or null when the entry draws a letter. The template keeps the
 * folder in the path so the bundler finds every file in it. */
export function iconUrl (icon: string | null): string | null {
  return icon === null ? null : new URL(`./featured/${icon}`, import.meta.url).href
}
