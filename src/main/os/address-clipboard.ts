// What the clipboard gets when an address is copied from Orivon's own UI: the address as text, and where another
// program can paste a link, the same text as a link to its web form (`web-link.ts`), so `ipfs://name.eth` pasted into
// a document or a chat can be followed from any browser. Pure; `address-clipboard-runner.ts` is the write.
import { webLinkDiffering } from './web-link.js'

export interface AddressClip {
  readonly text: string
  /** Present only when the address has a web link that is not the address itself. */
  readonly html?: string
}

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)

/** `address` as one line of the HTML, a link when it has a web link and escaped text when it has none. */
function htmlLine (address: string): { readonly html: string, readonly linked: boolean } {
  const link = webLinkDiffering(address)
  return link === undefined ? { html: escapeHtml(address), linked: false } : { html: `<a href="${escapeHtml(link)}">${escapeHtml(address)}</a>`, linked: true }
}

/** Several addresses, one per line: plain text, and an HTML form only when one of them has a link. */
export function addressesClip (addresses: readonly string[]): AddressClip {
  const text = addresses.join('\n')
  const lines = addresses.map(htmlLine)
  return lines.some((line) => line.linked) ? { text, html: lines.map((line) => line.html).join('<br>') } : { text }
}

export function addressClip (address: string): AddressClip {
  return addressesClip([address])
}
