// On Google's sign-in hosts, removes `navigator.userAgentData` from the page's
// own main world before its first script runs. Firefox, the identity those
// hosts are shown (src/main/shell/sign-in-identity.ts), has no such property:
// `'userAgentData' in navigator` is false there, and a Chromium brand list
// beside a Firefox User-Agent is the mismatch Google's sign-in check rejects.
// The property is deleted, never set to `undefined`, so that `in` reads false
// as it does in Firefox. Each document is a fresh realm: nothing needs
// restoring when the tab leaves the host.
//
// Runs in the main frame only (a tab's preload does not reach subframes), so
// a sign-in page embedded in another site's iframe keeps the property.

import { contextBridge } from 'electron'

/** Duplicated from src/main/shell/sign-in-identity.ts rather than imported:
 * src/preload/README.md forbids importing anything under src/main/ except
 * ./channels.ts. Keep the two lists identical. */
const SIGN_IN_HOSTS: readonly string[] = ['accounts.google.com', 'accounts.youtube.com']

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

/** The hosts a test build adds through ORIVON_TEST_SIGN_IN_HOSTS, read the
 * way src/main/shell/sign-in-identity-test-seam.ts reads them; `[]` in an
 * ordinary build, where SEAM_ENABLED is a literal `false` and this folds away. */
function seamHosts (): readonly string[] {
  if (!SEAM_ENABLED) return []
  const raw = process.env['ORIVON_TEST_SIGN_IN_HOSTS']
  return raw === undefined ? [] : raw.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
}

/** Runs in the page's main world through contextBridge.executeInMainWorld,
 * so it is self-contained: it closes over nothing from this module. The
 * property is an accessor on `Navigator.prototype` in Chromium, and an own
 * property on some builds; both are tried, each in its own try so a
 * non-configurable one cannot stop the other. */
function removeUserAgentData (): void {
  try { delete (navigator as unknown as Record<string, unknown>)['userAgentData'] } catch { /* not an own property here */ }
  try { delete (Navigator.prototype as unknown as Record<string, unknown>)['userAgentData'] } catch { /* non-configurable here */ }
}

/** Fail-open, like exposeShimGlobals(): `executeInMainWorld` is
 * `@experimental`, and a page that keeps `userAgentData` is degraded, not
 * broken. */
export function hideUserAgentDataOnSignInHosts (): void {
  if (![...SIGN_IN_HOSTS, ...seamHosts()].includes(location.host)) return
  try {
    contextBridge.executeInMainWorld({ func: removeUserAgentData })
  } catch (error) {
    console.error('[orivon] navigator.userAgentData not removed', error)
  }
}
