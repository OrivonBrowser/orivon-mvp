// What the "Sites that store data" list decides, apart from the page it is drawn on: the search, the two orders,
// how many rows show, and the words a row and the total are told in.
import type { SiteRow } from '../../../../main/privacy/site-data-domain.js'
import { countText } from '../../shared/cookie-text.js'
import { formatBytes } from '../../shared/format-bytes.js'

export type SiteSort = 'name' | 'size'

/** More rows than this start hidden behind "Show all". */
export const SITES_SHOWN = 100

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/** Sites whose domain or any host contains every word typed; all of them for an empty search. */
export function filterSites (sites: readonly SiteRow[], query: string): SiteRow[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== '')
  if (words.length === 0) return [...sites]
  return sites.filter((site) => {
    const text = `${site.domain} ${site.hosts.join(' ')}`.toLowerCase()
    return words.every((word) => text.includes(word))
  })
}

/** By name, or biggest first with the sites whose size is not known after the ones that are (then by cookies, then name). */
export function sortSites (sites: readonly SiteRow[], sort: SiteSort): SiteRow[] {
  const byName = (a: SiteRow, b: SiteRow): number => collator.compare(a.domain, b.domain)
  if (sort === 'name') return [...sites].sort(byName)
  return [...sites].sort((a, b) => {
    if (a.bytes !== null && b.bytes !== null && a.bytes !== b.bytes) return b.bytes - a.bytes
    if ((a.bytes === null) !== (b.bytes === null)) return a.bytes === null ? 1 : -1
    return b.cookies - a.cookies || byName(a, b)
  })
}

/** Size order only means something once a size is known. */
export function defaultSort (sites: readonly SiteRow[]): SiteSort {
  return sites.some((site) => site.bytes !== null) ? 'size' : 'name'
}

export function visibleSites<T> (rows: readonly T[], showAll: boolean): { readonly shown: readonly T[], readonly hidden: number } {
  if (showAll || rows.length <= SITES_SHOWN) return { shown: rows, hidden: 0 }
  return { shown: rows.slice(0, SITES_SHOWN), hidden: rows.length - SITES_SHOWN }
}

/** `3 cookies · IndexedDB · 1.2 MB`: what is kept, and how much where that is known. */
export function siteLine (site: Pick<SiteRow, 'cookies' | 'kinds' | 'bytes'>): string {
  const parts = [
    ...(site.cookies > 0 ? [countText(site.cookies)] : []),
    ...site.kinds,
    ...(site.bytes !== null ? [formatBytes(site.bytes)] : [])
  ]
  return parts.join(' · ')
}

/** `About 214 MB on this computer`; the figure is an estimate and says so. */
export function totalText (bytes: number | null): string {
  return bytes === null ? 'Calculating…' : `About ${formatBytes(bytes)} on this computer`
}
