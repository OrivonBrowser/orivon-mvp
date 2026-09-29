// Chrome's activeTab-adjacent rule for chrome.tabCapture.getMediaStreamId:
// an extension may capture a tab only after being INVOKED on it (a toolbar
// action click, in this first cut -- browser-action.ts's own patch calls
// recordInvocation from activateClick). A grant is per (extensionId, tabId)
// pair and lives until clearInvocation runs -- browser-action.ts's patch
// wires that to the tab's own navigation-to-another-origin and destruction,
// mirroring activeTab's real lifetime; this file holds only the ledger, no
// Electron event of its own, so it is unit-testable without a real tab.
const grants = new Set<string>()

function key (extensionId: string, tabId: number): string {
  return `${extensionId}\u0000${String(tabId)}`
}

export function recordInvocation (extensionId: string, tabId: number): void {
  grants.add(key(extensionId, tabId))
}

export function hasRecentInvocation (extensionId: string, tabId: number): boolean {
  return grants.has(key(extensionId, tabId))
}

export function clearInvocation (extensionId: string, tabId: number): void {
  grants.delete(key(extensionId, tabId))
}

/** (item K) The ledger otherwise survives an extension's own unload: a
 * disabled, uninstalled or crashed extension keeps whatever (extensionId,
 * tabId) grants it had, and a same-id reinstall (or, before Chrome's own
 * id-reuse rules, an unrelated extension landing on the same id slot) would
 * inherit them. Wired from `extension-host.ts`'s own 'extension-unloaded'
 * listener -- the same Electron signal `../sessions/tab-capture-grants.ts`'s
 * own consumers and `vendor/.../offscreen.ts`'s `closeForExtension` already
 * key off. Prefix match on `key()`'s own separator, since this ledger has
 * no per-extension index of its own to iterate directly. */
export function clearInvocationsForExtension (extensionId: string): void {
  const prefix = `${extensionId}\u0000`
  for (const entry of grants) {
    if (entry.startsWith(prefix)) grants.delete(entry)
  }
}
