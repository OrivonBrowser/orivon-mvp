// What the indicators say about running shares. Pure: no `electron` import.
import { formatOriginForDisplay } from '../../consent/grant-prompt-origin.js'
import type { ActiveShare, DisplaySurfaceKind } from '../types.js'

/** The newest share is the one a tab's badge, the chip and the bar name. */
export function newestShare (shares: readonly ActiveShare[]): ActiveShare | undefined {
  return shares.reduce<ActiveShare | undefined>((latest, share) => latest === undefined || share.startedAt >= latest.startedAt ? share : latest, undefined)
}

const PHRASE: Readonly<Record<DisplaySurfaceKind, string>> = { screen: 'your screen', window: 'a window', tab: 'a tab' }

/** The sentence the bar shows: the site, what it is sharing (its newest share) and how many more it has. */
export function barText (shares: readonly ActiveShare[]): string {
  const latest = newestShare(shares)
  if (latest === undefined) return ''
  const more = shares.length - 1
  return `${formatOriginForDisplay(latest.origin)} is sharing ${PHRASE[latest.kind]}${more > 0 ? ` and ${String(more)} more` : ''}`
}

/** The shares whose requesting page is in the window. */
export function sharesOfWindow (shares: readonly ActiveShare[], holds: (contents: ActiveShare['requester']) => boolean): ActiveShare[] {
  return shares.filter((share) => holds(share.requester))
}
