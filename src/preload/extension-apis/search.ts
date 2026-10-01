import type { Crx } from './crx.js'

/** `chrome.search`, defined when the manifest declares `search`. */
export function searchApi (): void {
  const crx = (globalThis as unknown as { __crx: Crx }).__crx
  if (!crx.declares('search')) return
  crx.define('search', () => ({ query: crx.call('search.query') }))
}
