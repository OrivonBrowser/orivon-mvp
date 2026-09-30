// What a page may be shared as: the address the person sees in the address bar, for a page that has one. The
// address comes from the tab's own state in main, never from anything a page hands in.
import { sanitizeDirectUrl } from '../browsing/omnibox.js'
import type { TabState } from '../shell/tab-types.js'
import { oneLine } from './one-line.js'

type Shareable = Pick<TabState, 'isNewTab' | 'isInternal' | 'displayUrl'>

/** The address to share for `tab`, or undefined for one that has none worth sharing: the new-tab page, the shell's own
 * pages, and any scheme the address bar would not load (an extension's page, `file:`, `view-source:`). */
export function shareAddressFor (tab: Shareable | undefined): string | undefined {
  if (tab === undefined || tab.isNewTab || tab.isInternal || tab.displayUrl === '') return undefined
  // Only the verdict is used: for a protocol's address the validator answers with the https URL serving it, and
  // what the person copies is the address they see.
  return sanitizeDirectUrl(tab.displayUrl) === null ? undefined : tab.displayUrl
}

/** A subject longer than this is cut: a mail program shows a line, and a page's title is not bounded. */
export const MAX_SUBJECT = 200

/** `title` as one line of plain text: a line break would end the subject header and start another. */
export function subjectFrom (title: string, address: string): string {
  const line = oneLine(title)
  return Array.from(line === '' ? address : line).slice(0, MAX_SUBJECT).join('')
}

/** The `mailto:` address that opens a new message about the page. Both parts are percent-encoded, so neither can
 * add a recipient, a header or a second parameter. */
export function mailtoFor (title: string, address: string): string {
  return `mailto:?subject=${encodeURIComponent(subjectFrom(title, address))}&body=${encodeURIComponent(address)}`
}
