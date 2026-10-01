// An origin the person allowed an extension to ask for counts for every host
// check the moment it is granted, before the extension reloads with it in its
// manifest. The rule answers true for such a URL and leaves everything else to
// the next rule and the manifest.
import { matchesAnyHostPattern } from '../../broker/policy/extension-host-patterns.js'
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
