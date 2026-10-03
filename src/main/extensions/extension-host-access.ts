// The host-access decision chrome.cookies and chrome.tabs both gate on
// (README.md's Design notes): whether a loaded extension's OWN manifest
// covers a given URL. Reuses readExtensionManifest's hostPermissions
// extraction (broker/policy/extension-manifest.ts) so a loaded extension's
// runtime manifest (`event.extension.manifest`, read here as `unknown`
// since it arrives through a vendored library's own type) is parsed the
// same way an install-time one is, then matched with Chrome's own
// match-pattern grammar (broker/policy/extension-host-patterns.ts).
//
// hostPermissions, never hostPatterns: extension-manifest.ts's own doc on
// the two fields says why -- a content_scripts match pattern lets an
// extension inject a script there, not call a host-gated API.
//
// No electron import: this file is a thin, pure-ish adapter between the
// two policy modules above and the vendored setters' own `unknown`-typed
// manifest parameter, so it needs none of Electron's own runtime.

import { matchesAnyHostPattern } from '../../broker/policy/extension-host-patterns.js'
import { readExtensionManifest } from '../../broker/policy/extension-manifest.js'
import { grantedHostRule, revokedHostRule } from './granted-host-rule.js'

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

/** `patterns` (an extension's explicit host permissions, already read out of its manifest) cover `url`. */
function patternsCover (patterns: readonly string[], url: string | undefined): boolean {
  if (url === undefined) return false
  // No extension ever gets file access, so file: is never covered here --
  // README.md's "allowFileAccess is never true" entry has why.
  if (url.startsWith('file:')) return false
  return matchesAnyHostPattern(patterns, url)
}

/** True when `manifest`'s own explicit host_permissions (plus MV2's
 * host-pattern entries in `permissions`) cover `url` -- never a
 * content_scripts match alone. `undefined` never matches -- a tab or
 * cookie with no resolvable URL yet (a still-loading tab, a malformed
 * cookie domain) carries nothing a host pattern could cover. */
export function hasHostAccess (manifest: unknown, url: string | undefined): boolean {
  if (url === undefined || url.startsWith('file:')) return false
  const result = readExtensionManifest(manifest)
  if (!result.ok) return false
  return patternsCover(result.facts.hostPermissions, url)
}

/** Chrome's own rule for chrome.cookies and the sensitive chrome.tabs
 * fields (url, pendingUrl, title, favIconUrl): the `tabs`/`cookies`
 * permission on its own is enough, OR a host permission matching the URL
 * in question -- either one, not both. */
export function hasApiOrHostAccess (manifest: unknown, apiPermission: string, url: string | undefined): boolean {
  return hasApiPermission(manifest, apiPermission) || hasHostAccess(manifest, url)
}

/** One extra rule on top of the manifest's own host permissions: a question
 * about `extensionId` reaching `url` (on tab `tabId`, when the question is
 * about a tab), answered true, false, or undefined to leave it to the next
 * rule. The first rule that answers wins, and a rule may only narrow or widen
 * what the manifest says for the extension it names. */
export interface HostAccessQuestion { readonly extensionId: string, readonly url: string | undefined, readonly tabId?: number | undefined }
export type HostAccessRule = (question: HostAccessQuestion) => boolean | undefined

export const HOST_ACCESS_RULES: ReadonlyArray<HostAccessRule> = [
  grantedHostRule,
  revokedHostRule
]

/** What `hasHostAccess` answers, after the rules above have had their say,
 * for a caller that already holds the extension's host permissions: a request
 * path asks this per URL and reads the manifest once, not once per question. */
export function hostAccessForPatterns (extensionId: string, hostPermissions: readonly string[], url: string | undefined, tabId?: number): boolean {
  for (const rule of HOST_ACCESS_RULES) {
    const answer = rule({ extensionId, url, tabId })
    if (answer !== undefined) return answer
  }
  return patternsCover(hostPermissions, url)
}

/** `hostAccessForPatterns` over an extension's own manifest. Every
 * host-gated API call and event goes through one of the two, so a rule
 * applies everywhere at once. */
export function hostAccessFor (extensionId: string, manifest: unknown, url: string | undefined, tabId?: number): boolean {
  const result = readExtensionManifest(manifest)
  return hostAccessForPatterns(extensionId, result.ok ? result.facts.hostPermissions : [], url, tabId)
}

/** `hasApiOrHostAccess` through `hostAccessFor`. */
export function apiOrHostAccessFor (extensionId: string, manifest: unknown, apiPermission: string, url: string | undefined, tabId?: number): boolean {
  return hasApiPermission(manifest, apiPermission) || hostAccessFor(extensionId, manifest, url, tabId)
}
