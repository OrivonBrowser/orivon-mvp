// Which web address a document's site rules come from. A document with no web address of its own (a blank popup, a
// `blob:` page) runs with the origin that made it, so the pop-up, download and sound rules of that site apply to it.
// Pure: no `electron` import.

const isWebAddress = (url: string): boolean => url.startsWith('http://') || url.startsWith('https://')
const isBlank = (url: string): boolean => url === '' || url === 'about:blank'

/** The web address inside a `blob:` address, or undefined when the document it made had an opaque origin. */
function blobInner (url: string): string | undefined {
  const inner = url.slice('blob:'.length)
  return isWebAddress(inner) ? inner : undefined
}

/** A web address whose site the rules are looked up for, or `unknown` for a document that is the site's but whose site cannot be told. */
export type RuleAddress = string | 'unknown'

/**
 * The web address whose site rules apply to the document at `url`: itself when it is a website, the address inside a
 * `blob:` address, the opener's for a blank document. `'unknown'` when the document is a blank or `blob:` one whose site
 * cannot be told (no opener, an opener that is itself blank, or an opaque origin): the caller applies the kind's default.
 * Undefined for a document that has no setting at all (a shell page, a file, an extension's page).
 */
export function ruleAddress (url: string | undefined, openerUrl: (() => string | undefined) | undefined): RuleAddress | undefined {
  if (url === undefined) return undefined
  if (isWebAddress(url)) return url
  if (url.startsWith('blob:')) return blobInner(url) ?? 'unknown'
  // A blank document with no way to ask for its opener is a bare view (a request's page, a chip): nothing to rule on.
  if (!isBlank(url) || openerUrl === undefined) return undefined
  const opener = openerUrl()
  if (opener === undefined || isBlank(opener)) return 'unknown'
  if (isWebAddress(opener)) return opener
  if (opener.startsWith('blob:')) return blobInner(opener) ?? 'unknown'
  // The opener is a shell page or an app's non-web page: the same "no setting" as the opener itself would have.
  return undefined
}

/** The address of the frame that opened `contents`, or undefined when there is none or it can no longer be read (Electron throws on a destroyed frame). */
export function openerUrlOf (contents: { readonly opener?: { readonly url: string } | null }): string | undefined {
  try {
    return contents.opener?.url
  } catch {
    return undefined
  }
}
