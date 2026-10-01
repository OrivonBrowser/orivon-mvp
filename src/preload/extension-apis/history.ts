import type { Crx } from './crx.js'

/** `chrome.history`, defined when the manifest declares the permission (required or optional). */
export function historyApi (): void {
  const crx = (globalThis as unknown as { __crx: Crx }).__crx
  if (!crx.declares('history')) return
  crx.define('history', () => ({
    search: crx.call('history.search'),
    getVisits: crx.call('history.getVisits'),
    addUrl: crx.call('history.addUrl'),
    deleteUrl: crx.call('history.deleteUrl'),
    deleteRange: crx.call('history.deleteRange'),
    deleteAll: crx.call('history.deleteAll'),
    onVisited: crx.event('history.onVisited'),
    onVisitRemoved: crx.event('history.onVisitRemoved')
  }))
}
