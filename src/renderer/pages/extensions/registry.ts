// The one place a feature plugs into the extensions page: a view per route, a
// section per feature on the details view, a badge per feature on a list card.
// Add a line to the list that fits, in order; no other file changes.
import type { CardBadge, DetailSection, ExtensionView } from './types.js'
import type { ViewName } from './router.js'
import { aboutSection } from './views/details-about.js'
import { detailsView } from './views/details.js'
import { optionalSection } from './views/details-optional.js'
import { listView } from './views/list.js'
import { stubView } from './views/stub.js'

export type { CardBadge, DetailSection, ExtensionView, PageContext } from './types.js'

/** One per line; shown sorted by `order`. */
export const DETAIL_SECTIONS: readonly DetailSection[] = [
  aboutSection,
  optionalSection
]

/** One per line. */
export const CARD_BADGES: readonly CardBadge[] = []

const sortedSections = [...DETAIL_SECTIONS].sort((a, b) => a.order - b.order)

export const EXTENSION_VIEWS: Readonly<Record<ViewName, ExtensionView>> = {
  details: detailsView(sortedSections),
  errors: stubView('Error log', 'The log of what went wrong in this extension will appear here.'),
  list: listView(CARD_BADGES),
  shortcuts: stubView('Keyboard shortcuts', 'Shortcuts that extensions offer will appear here.')
}
