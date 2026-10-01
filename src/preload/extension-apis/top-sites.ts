import type { Crx } from './crx.js'

/** `chrome.topSites`, over the library's empty stub of the same name, once the manifest declares the permission. */
export function topSitesApi (): void {
  const crx = (globalThis as unknown as { __crx: Crx }).__crx
  if (!crx.declares('topSites')) return
  crx.define('topSites', () => ({ get: crx.call('topSites.get') }))
}
