// An origin the person allowed an extension to ask for counts for every host
// check the moment it is granted, before the extension reloads with it in its
// manifest, and one the person took back stops counting the same moment. The
// first rule answers true for a granted URL, the second false for a URL that
// neither the installed manifest nor a grant covers; everything else is left to
// the manifest.
import { matchesAnyHostPattern } from '../../broker/policy/extension-host-patterns.js'
import { baseManifestOf } from './base-manifest-source.js'
import { readExtensionManifest } from '../../broker/policy/extension-manifest.js'
import type { ExtensionPrefsStore } from './extension-prefs.js'
import type { HostAccessRule } from './extension-host-access.js'

let prefs: Pick<ExtensionPrefsStore, 'get'> | undefined

/** `permissions-api.ts` hands in the store when it installs. */
export function setGrantedHostSource (source: Pick<ExtensionPrefsStore, 'get'> | undefined): void {
  prefs = source
}

export const grantedHostRule: HostAccessRule = ({ extensionId, url }) => {
  if (prefs === undefined || url === undefined || url.startsWith('file:')) return undefined
  const { origins } = prefs.get(extensionId).granted
  return origins.length > 0 && matchesAnyHostPattern(origins, url) ? true : undefined
}

/**
 * A URL neither the installed manifest nor a grant covers is not reachable, even while the loaded manifest still
 * carries a grant the person has taken back (it drops out at the next reload). Answers false for it and leaves
 * everything else to the next rule.
 */
export const revokedHostRule: HostAccessRule = ({ extensionId, url }) => {
  if (prefs === undefined || url === undefined || url.startsWith('file:')) return undefined
  const base = baseManifestOf(extensionId)
  if (base === undefined) return undefined
  const result = readExtensionManifest(base)
  if (!result.ok) return undefined
  const covering = [...result.facts.hostPermissions, ...prefs.get(extensionId).granted.origins]
  return matchesAnyHostPattern(covering, url) ? undefined : false
}
