import { showToast } from '../../page-tools/toast.js'
import type { ChromeAction } from '../chrome-actions.js'
import { MAX_PASTED_LENGTH } from '../paste-and-go.js'

/** `{ text }`: all the text of the address field, which a copy of it hands over so the clipboard gets the address
 * with its web link (`../../os/address-clipboard.ts`). True once it is written. The text is the chrome's, so it is
 * only checked for its kind and size: a string of an address's length, never empty. The chrome has already stopped the
 * browser's own copy, so a write that fails says so, or the person would paste what was there before. */
export const addressCopy: ChromeAction = async (payload, { window, copyAddress }) => {
  const text = (payload as { text?: unknown } | null)?.text
  if (typeof text !== 'string' || text === '' || text.length > MAX_PASTED_LENGTH) return false
  try {
    await copyAddress(text)
    return true
  } catch (error) {
    console.error('[shell] could not copy the address', error)
    showToast(window, 'linkCopyFailed')
    return false
  }
}
