// Gives a manifest sandbox.pages document the same CSP `sandbox` directive
// real Chrome gives it, so it gets an opaque ("null") origin -- measured
// directly (docs/decisions/resolved-questions.md A299): Electron serves such a page at
// its extension's own `chrome-extension://<id>` origin, unlike Chrome,
// which is what lets it reach the extension's storage, or a framing
// extension page's DOM and that page's chrome.* (patch 37 alone only stops
// a chrome.* binding from being injected into the sandboxed page itself).
// Registered through ../sessions/web-request-owner.ts
// (webRequestOwnerFor), never session.webRequest directly -- README.md's
// own Design notes. `onHeadersReceived` does fire for a chrome-extension://
// response in the default session -- measured directly, not assumed.

import { session } from 'electron'
import type { OnHeadersReceivedListenerDetails, WebRequestFilter } from 'electron'
import { isSandboxPageUrl } from 'orivon:crx-extensions-router'
import { extensionIdFromScope } from './extension-sw-preload-recovery.js'
import { withAppendedCsp } from '../install/granted-origin-csp.js'
import type { HeadersReceivedHandler } from '../sessions/web-request-owner.js'

/** Chrome's own default CSP for a sandboxed extension page (no
 * `allow-same-origin` -- the whole point is that this document does NOT
 * share the extension's origin), used unless the manifest's own
 * `content_security_policy.sandbox` overrides it. */
export const CHROME_DEFAULT_SANDBOX_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self' 'unsafe-inline' 'unsafe-eval'; child-src 'self';"

/** Every `chrome-extension:` URL, document resource types only: CSP
 * `sandbox` is a document-level policy (it changes the resulting browsing
 * context's own origin and script permissions), meaningless attached to a
 * subresource fetch (`sandbox.js`) that establishes no browsing context of
 * its own. `object` counts as a document here too, the same reasoning
 * `../install/granted-origin-csp.ts`'s own `GRANTED_ORIGIN_CSP_FILTER` and
 * `documentOriginOf` already document: Electron reports a same-origin
 * `<object>`/`<embed>` document's own response with that resource type
 * (measured, Electron 44) -- a manifest's own `web_accessible_resources`
 * can make a sandbox page reachable that way from an ordinary web page, and
 * without `object` here that document was served with no CSP `sandbox` at
 * all, silently keeping its ordinary (non-opaque) origin. */
export const EXTENSION_SANDBOX_CSP_FILTER: WebRequestFilter = { urls: ['chrome-extension://*/*'], types: ['mainFrame', 'subFrame', 'object'] }

/** True if `csp` declares an actual `sandbox` directive -- a CSP
 * directive's name is whatever precedes the first run of whitespace in its
 * own `;`-separated segment, so a `"sandbox"` appearing only inside some
 * OTHER directive's value does not count. Real Chrome rejects a manifest
 * `content_security_policy.sandbox` value that lacks this directive
 * outright and falls back to its own default sandbox CSP instead of
 * applying a policy that does not actually sandbox anything; this mirrors
 * that, rather than trusting the manifest's override unconditionally. */
function hasSandboxDirective (csp: string): boolean {
  return csp.split(';').some((segment) => segment.trim().split(/\s+/)[0]?.toLowerCase() === 'sandbox')
}

function sandboxCspFor (details: OnHeadersReceivedListenerDetails): string | undefined {
  if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame' && details.resourceType !== 'object') return undefined
  const id = extensionIdFromScope(details.url)
  if (id === undefined) return undefined
  const manifest = session.defaultSession.extensions.getExtension(id)?.manifest as {
    sandbox?: { pages?: string[] }
    content_security_policy?: { sandbox?: string }
  } | undefined
  if (manifest?.sandbox?.pages === undefined) return undefined
  if (!isSandboxPageUrl(manifest.sandbox.pages, details.url)) return undefined
  const override = manifest.content_security_policy?.sandbox
  return override !== undefined && hasSandboxDirective(override) ? override : CHROME_DEFAULT_SANDBOX_CSP
}

/** `webRequestOwnerFor(session.defaultSession).onHeadersReceived`'s own
 * handler shape -- appends the sandbox CSP to whatever headers the
 * response already carries (browsers enforce the intersection of every
 * CSP header sent, so this only ever narrows, matching
 * `withAppendedCsp`'s own doc). Every extension page not declared under
 * `sandbox.pages` passes through completely unchanged. */
export function extensionSandboxCsp (): HeadersReceivedHandler {
  return (details, current) => {
    const csp = sandboxCspFor(details)
    if (csp === undefined) return current
    return { ...current, responseHeaders: withAppendedCsp(current.responseHeaders, csp) }
  }
}
