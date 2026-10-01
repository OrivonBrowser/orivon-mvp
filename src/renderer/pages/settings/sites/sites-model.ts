// What the "Sites with their own settings" list decides apart from the page it is drawn on: how a site reads, what
// the search keeps, how many rows show and which badges summarise a site. Pure, so it is tested without a page.
import { hostOf } from '../passwords/passwords-model.js'
import type { DefaultRow, SiteKindRow, SiteSummary } from '../../../../main/site-settings/site-settings-controller.js'

export type { DefaultRow, SiteKindRow, SiteSummary }
// The site's name and its mark are drawn the way the Passwords list draws them.
export { hostOf, markColor, markLetter } from '../passwords/passwords-model.js'

/** More than this many sites start hidden behind "Show all". */
export const SHOWN_LIMIT = 100
/** A site's row names this many of its answers; the rest read "+n". */
export const BADGE_LIMIT = 3

export interface Badge { readonly text: string, readonly tone: 'ok' | 'danger' }

/** The names a badge uses where the kind's own label is long. */
const SHORT_LABEL: Readonly<Record<string, string>> = {
  popups: 'Pop-ups',
  clipboardRead: 'Clipboard',
  midi: 'MIDI',
  windowManagement: 'Window management',
  autoDownloads: 'Automatic downloads'
}

/** "Camera allowed": the kind and what the site was told. */
export function badgeFor (answer: SiteSummary['kinds'][number]): Badge {
  const name = SHORT_LABEL[answer.kind] ?? answer.label
  return answer.value === 'allow' ? { text: `${name} allowed`, tone: 'ok' } : { text: `${name} blocked`, tone: 'danger' }
}

export function badgesFor (site: SiteSummary): { readonly shown: readonly Badge[], readonly more: number } {
  const all = site.kinds.map(badgeFor)
  return { shown: all.slice(0, BADGE_LIMIT), more: Math.max(0, all.length - BADGE_LIMIT) }
}

/** What a screen reader hears for the whole row. */
export function sentenceFor (site: SiteSummary): string {
  return `${hostOf(site.origin)}: ${site.kinds.map((answer) => badgeFor(answer).text).join(', ')}`
}

/** The sites every word of `query` appears in, by host, in the order given. */
export function filterSites (sites: readonly SiteSummary[], query: string): SiteSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== '')
  return sites.filter((site) => {
    const host = hostOf(site.origin).toLowerCase()
    return words.every((word) => host.includes(word))
  })
}

/** The first rows, unless all were asked for. */
export function visibleSites (sites: readonly SiteSummary[], showAll: boolean): { readonly shown: readonly SiteSummary[], readonly hidden: number } {
  if (showAll || sites.length <= SHOWN_LIMIT) return { shown: sites, hidden: 0 }
  return { shown: sites.slice(0, SHOWN_LIMIT), hidden: sites.length - SHOWN_LIMIT }
}
