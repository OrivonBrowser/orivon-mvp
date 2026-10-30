import type { ChromeAction } from '../chrome-actions.js'
import { MAX_PASTED_LENGTH } from '../paste-and-go.js'

/** `{ text }`: all the text of the address field, which a copy of it hands over so the clipboard gets the address
 * with its web link (`../../os/address-clipboard.ts`). True once it is written. The text is the chrome's, so it is
 * only checked for its kind and size: a string of an address's length, never empty. */
export const addressCopy: ChromeAction = (payload, { copyAddress }) => {
  const text = (payload as { text?: unknown } | null)?.text
  if (typeof text !== 'string' || text === '' || text.length > MAX_PASTED_LENGTH || copyAddress === undefined) return false
  try {
    copyAddress(text)
    return true
  } catch (error) {
    console.error('[shell] could not copy the address', error)
    return false
  }
}
