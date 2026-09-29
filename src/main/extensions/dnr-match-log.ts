// The per-tab match history `declarativeNetRequest.getMatchedRules` reads
// and the action-count state `setExtensionActionOptions`/badge display use.
// Electron-free (plain in-memory state), but lives outside dnr/ since it is
// about a real session's tabs, not the rule engine itself.

import type { DnrMatchedRuleInfo } from './dnr/types.js'

const MATCH_LOG_TTL_MS = 5 * 60 * 1000

interface LoggedMatch {
  readonly info: DnrMatchedRuleInfo
  readonly tabId: number
  readonly timestamp: number
}

let matches: LoggedMatch[] = []

function pruneMatches(now: number): void {
  matches = matches.filter((entry) => now - entry.timestamp <= MATCH_LOG_TTL_MS)
}

/** Called once per matched rule, from the `onBeforeRequest` handler
 * (`dnr-webrequest.ts`) -- Chrome's own `getMatchedRules` window is "the
 * last few minutes"; this package's own choice is 5, named above. */
export function recordMatches(tabId: number, matchedRules: readonly DnrMatchedRuleInfo[]): void {
  if (matchedRules.length === 0) {
    return
  }
  const now = Date.now()
  for (const info of matchedRules) {
    matches.push({ info, tabId, timestamp: now })
  }
  pruneMatches(now)
}

export interface LoggedMatchInfo {
  readonly info: DnrMatchedRuleInfo
  readonly tabId: number
  readonly timestamp: number
}

/** `tabId === undefined` reads every tracked tab (Chrome allows this only
 * with `declarativeNetRequestFeedback`; the caller has already checked
 * that -- see `dnr-api.ts`). */
export function getLoggedMatches(extensionId: string, tabId: number | undefined): LoggedMatchInfo[] {
  pruneMatches(Date.now())
  return matches.filter((entry) => entry.info.extensionId === extensionId && (tabId === undefined || entry.tabId === tabId))
}

/** `declarativeNetRequest.setExtensionActionOptions`'s persistent toggle,
 * per extension, and the per-(extension,tab) count it drives. Chrome
 * displays this count as the toolbar action's badge text once the toggle is
 * on; nothing in this repository renders it there yet (see
 * `dnr-api.ts`'s own doc on `setExtensionActionOptions`) -- the count itself
 * is tracked correctly so a later toolbar-rendering change has real data to
 * read.
 */
const badgeTextEnabled = new Map<string, boolean>()
const actionCounts = new Map<string, number>()

function actionCountKey(extensionId: string, tabId: number): string {
  return `${extensionId}:${String(tabId)}`
}

export function setDisplayActionCountAsBadgeText(extensionId: string, enabled: boolean): void {
  badgeTextEnabled.set(extensionId, enabled)
}

export function isDisplayActionCountAsBadgeTextEnabled(extensionId: string): boolean {
  return badgeTextEnabled.get(extensionId) ?? false
}

export function incrementActionCount(extensionId: string, tabId: number, delta: number): void {
  const key = actionCountKey(extensionId, tabId)
  actionCounts.set(key, (actionCounts.get(key) ?? 0) + delta)
}

export function getActionCount(extensionId: string, tabId: number): number {
  return actionCounts.get(actionCountKey(extensionId, tabId)) ?? 0
}

/** `removeExtension` on disable/uninstall clears this extension's own
 * bookkeeping too, so a later reinstall/re-enable starts clean. Matches by
 * other extensions are untouched. */
export function clearExtensionMatchLog(extensionId: string): void {
  matches = matches.filter((entry) => entry.info.extensionId !== extensionId)
  badgeTextEnabled.delete(extensionId)
  for (const key of [...actionCounts.keys()]) {
    if (key.startsWith(`${extensionId}:`)) {
      actionCounts.delete(key)
    }
  }
}
