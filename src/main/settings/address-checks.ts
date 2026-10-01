// The two shapes of address a setting may hold, decided by the address bar's own rule so a saved
// page opens exactly as the same text typed in the bar would.
import { parseOmniboxInput } from '../browsing/omnibox.js'

/** Most pages a "pages to open" list may hold. */
export const MAX_LISTED_ADDRESSES = 8

function isAddress (text: string): boolean {
  return parseOmniboxInput(text).kind === 'url'
}

/** Empty, or one address. */
export function isEmptyOrAddress (value: string): boolean {
  return value === '' || isAddress(value)
}

/** Empty, or one address per line, at most MAX_LISTED_ADDRESSES of them; a blank line is skipped. */
export function isAddressList (value: string): boolean {
  const lines = value.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  return lines.length <= MAX_LISTED_ADDRESSES && lines.every(isAddress)
}
