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
 * per extension, and the per-(extension,tab) count it drives. `dnr-api.ts`
 * renders this count as the extension's toolbar badge (through
 * `ElectronChromeExtensions.setBadgeText`, UPSTREAM.md patch 44) whenever it
 * changes -- on a rule match (`incrementActionCount`, below) and on a fresh
 * navigation (`resetActionCountForTab`, below, Chrome's own "a new page
 * starts a new count").
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

/** Every extension currently in badge-count mode -- `dnr-api.ts`'s
 * navigation handler uses this to know which badges to blank out
 * alongside `resetActionCountForTab`, without walking every loaded
 * extension itself. */
export function extensionIdsWithBadgeTextEnabled(): string[] {
  return [...badgeTextEnabled.entries()].filter(([, enabled]) => enabled).map(([extensionId]) => extensionId)
}

/** Whether ANY extension currently has badge-count mode on -- half of
 * `dnr-webrequest.ts`'s gate on whether `recordMatches` (below) is worth
 * calling at all for a given request; the other half is
 * `extensions-dnr.ts`'s `hasFeedbackCapableExtension`. */
export function hasAnyBadgeCountModeEnabled(): boolean {
  return [...badgeTextEnabled.values()].some((enabled) => enabled)
}

export function incrementActionCount(extensionId: string, tabId: number, delta: number): void {
  const key = actionCountKey(extensionId, tabId)
  actionCounts.set(key, (actionCounts.get(key) ?? 0) + delta)
}

export function getActionCount(extensionId: string, tabId: number): number {
  return actionCounts.get(actionCountKey(extensionId, tabId)) ?? 0
}

/** Zeroes `tabId`'s count for every extension -- called on a `main_frame`
 * request (`dnr-webrequest.ts`'s own doc on `OnTabNavigated`), the same
 * "a fresh page load starts a fresh count" rule Chrome's own per-tab
 * action count follows. Every extension's count for that tab is cleared
 * regardless of which one is in badge-count mode: the count itself is
 * still real state (`getActionCount`, `declarativeNetRequest.
 * getMatchedRules`'s own window), not only a badge's input. */
export function resetActionCountForTab(tabId: number): void {
  const suffix = `:${String(tabId)}`
  for (const key of [...actionCounts.keys()]) {
    if (key.endsWith(suffix)) {
      actionCounts.delete(key)
    }
  }
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
