// What an extension may put in an Orivon tab: a `chrome.tabs.create`,
// `chrome.windows.create` or `chrome.tabs.update` URL, after the library's
// own `validateExtensionUrl` (vendor/electron-chrome-extensions/src/browser/
// api/common.ts) has already resolved it relative to the extension's origin
// and refused `chrome:`/`javascript:`. That check is not enough on its own:
// it still lets `file:`, `data:`, `orivon:` and `devtools:` through, every
// one of them a route this shell already treats as chrome-privileged input
// everywhere else (src/main/browsing/omnibox.ts's own header makes the same
// argument for the address bar). Pure function: no Electron import, so it is
// unit-tested under plain vitest, matching src/main/extensions/README.md's
// suffix rule for "the decision".
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'

/** Matches tab-factory.ts's own BLANK_URL: the one non-http(s) target an
 * extension's own createTab()/windows.create() may still land on. */
const BLANK_URL = 'about:blank'

/** True if `id` names an extension loaded in the session extension-opened
 * tabs run in (session.defaultSession) -- passed in rather than imported so
 * this file stays free of an Electron import. */
export type IsLoadedExtension = (id: string) => boolean

/**
 * Allowed: `http:`/`https:`, a built-in protocol's served URL
 * (`BUILTIN_ADDRESSES.servedUrl`, the same table the omnibox uses),
 * `about:blank`, and `chrome-extension://<id>/...` when `<id>` names an
 * extension `isLoadedExtension` reports as loaded. Refused: `file:`,
 * `javascript:`, `data:`, `orivon:`, `chrome:`, `devtools:`, and anything
 * else -- including a scheme-less or malformed string, which no branch
 * below matches.
 *
 * Returns the exact string to load, or `undefined` for a refusal --
 * `rawUrl` is already close to absolute (an extension URL, or one the
 * library resolved against it), so this never falls back to a search the
 * way `parseOmniboxInput` does for typed address-bar text.
 */
export function extensionOpenedUrl (rawUrl: string, isLoadedExtension: IsLoadedExtension): string | undefined {
  const trimmed = rawUrl.trim()
  if (trimmed === BLANK_URL) return BLANK_URL

  const served = BUILTIN_ADDRESSES.servedUrl(trimmed)
  if (served !== undefined) return served

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).toString()
    } catch {
      return undefined
    }
  }

  if (/^chrome-extension:\/\//i.test(trimmed)) {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return undefined
    }
    return isLoadedExtension(parsed.hostname) ? parsed.toString() : undefined
  }

  return undefined
}
