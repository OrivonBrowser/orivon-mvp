// The host-access decision chrome.cookies and chrome.tabs both gate on now
// (README.md's Design notes): whether a loaded extension's OWN manifest
// covers a given URL. Reuses readExtensionManifest's hostPatterns
// extraction (broker/policy/extension-manifest.ts) so a loaded extension's
// runtime manifest (`event.extension.manifest`, read here as `unknown`
// since it arrives through a vendored library's own type) is parsed the
// same way an install-time one is, then matched with Chrome's own
// match-pattern grammar (broker/policy/extension-host-patterns.ts).
//
// No electron import: this file is a thin, pure-ish adapter between the
// two policy modules above and the vendored setters' own `unknown`-typed
// manifest parameter, so it needs none of Electron's own runtime.

import { matchesAnyHostPattern } from '../../broker/policy/extension-host-patterns.js'
import { readExtensionManifest } from '../../broker/policy/extension-manifest.js'

/** True when `manifest` (an extension's own loaded manifest.json) declares
 * the plain API permission `name` in its top-level `permissions` array --
 * the same single-permission shape router.ts's own `permission` handler
 * option already checks against the SAME manifest, reused here for the
 * cases that option cannot express (an event broadcast, not a handler
 * call: webNavigation.* events, tabs.onCreated/onUpdated). */
export function hasApiPermission (manifest: unknown, name: string): boolean {
  const permissions = (manifest as { permissions?: unknown } | null | undefined)?.permissions
  return Array.isArray(permissions) && permissions.includes(name)
}

/** True when `manifest`'s own host_permissions/permissions/content_scripts
 * cover `url`. `undefined` never matches -- a tab or cookie with no
 * resolvable URL yet (a still-loading tab, a malformed cookie domain)
 * carries nothing a host pattern could cover. */
export function hasHostAccess (manifest: unknown, url: string | undefined): boolean {
  if (url === undefined) return false
  const result = readExtensionManifest(manifest)
  if (!result.ok) return false
  return matchesAnyHostPattern(result.facts.hostPatterns, url)
}

/** Chrome's own rule for chrome.cookies and the sensitive chrome.tabs
 * fields (url, pendingUrl, title, favIconUrl): the `tabs`/`cookies`
 * permission on its own is enough, OR a host permission matching the URL
 * in question -- either one, not both. */
export function hasApiOrHostAccess (manifest: unknown, apiPermission: string, url: string | undefined): boolean {
  return hasApiPermission(manifest, apiPermission) || hasHostAccess(manifest, url)
}
