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
