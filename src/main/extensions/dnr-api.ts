// Main-side handlers for chrome.declarativeNetRequest, registered on the
// same ExtensionRouter the library's own APIs use (UPSTREAM.md patch 43's
// `getRouter()`), reached from the renderer's real `invokeExtension`
// calls (`vendor/electron-chrome-extensions/src/renderer/index.ts`, patch 10's
// `declarativeNetRequest` factory). `setPermissionCheck` (patch 43)
// is what lets `{ permission: 'declarativeNetRequest' }` below gate on the
// ORIGINAL permission Orivon recorded in `registry.ts`'s `StrippedRecord`,
// since the loaded manifest no longer has it.

import type { ExtensionRouterHandle } from 'orivon:crx-extensions'
import { setPermissionCheck } from 'orivon:crx-extensions-router'
import type { Session } from 'electron'
import { getCachedStrippedPermissions, getDnrEngine, slotDirForLoadedExtension } from './extensions-dnr.js'
import { writeDynamicRules, writeEnabledRulesetOverride } from './dnr/dnr-runner.js'
import {
  extensionIdsWithBadgeTextEnabled,
  getActionCount,
  getLoggedMatches,
  incrementActionCount,
  isDisplayActionCountAsBadgeTextEnabled,
  resetActionCountForTab,
  setDisplayActionCountAsBadgeText,
} from './dnr-match-log.js'
import type { OnRuleMatched, OnTabNavigated } from './dnr-webrequest.js'
import type {
  DnrEngine,
} from './dnr/dnr-engine.js'
import type { DnrRequest, DnrResourceType, DnrRule, DnrUpdateRuleOptions, DnrUpdateRulesetOptions } from './dnr/types.js'

const DNR_PERMISSION = 'declarativeNetRequest'
const DNR_HOST_ACCESS_PERMISSION = 'declarativeNetRequestWithHostAccess'

/** The one method `registerDnrApiHandlers`'s badge wiring needs from
 * `ElectronChromeExtensions` (`setBadgeText`, UPSTREAM.md patch 44) --
 * narrowed to this rather than importing the whole ambient class type, so
 * a test can fake it with a plain object instead of a real extension host. */
export interface BadgeHost {
  readonly setBadgeText: (extensionId: string, tabId: number, text: string) => void
}

/** A permission `loadableManifest` strips from the loaded copy (native
 * messaging and every `webRequest*`/`declarativeNetRequest*` name,
 * `src/main/extensions/README.md`'s Design notes): checked against the
 * ORIGINAL record instead of the loaded manifest. Every other permission
 * name is unaffected by stripping, so the loaded manifest's own
 * `manifest.permissions` still answers those correctly. */
export function isStrippedPermissionName(permission: string): boolean {
  return permission === 'nativeMessaging' || permission.startsWith('declarativeNetRequest') || permission.startsWith('webRequest')
}

/** `extensionId`'s ORIGINAL (pre-strip) permission list -- `extensions-dnr.ts`'s
 * own load-time cache, not a fresh `registry.json` read: this is called once
 * per matched rule on the `onBeforeRequest` hot path (`onRuleMatched`,
 * below), so a disk read and a full-registry JSON parse per match would
 * scale with request volume rather than with how often an extension loads
 * or unloads. */
function strippedPermissionsFor(extensionId: string): readonly string[] {
  return getCachedStrippedPermissions(extensionId)
}

/**
 * Installed once, before any extension's `crx-msg` traffic: overrides the
 * router's default manifest-permission check globally (there is one router
 * per session, and Orivon runs extensions in exactly one), falling back to
 * the loaded manifest's own permissions for a name that was never stripped.
 * Chrome unlocks `chrome.declarativeNetRequest` for either
 * `declarativeNetRequest` or `declarativeNetRequestWithHostAccess`
 * (`extensions-dnr.ts`'s own `hasDnrPermission` doc has the citation this
 * package's runtime gating agrees with); every handler below gates on the
 * plain `declarativeNetRequest` string (`DNR_PERMISSION`, `gated`), so this
 * is the one place that string is treated as "either permission" rather
 * than a literal match. `declarativeNetRequestFeedback` is never accepted
 * here as a substitute -- `getMatchedRules`'s own handler checks it
 * separately, as Chrome requires.
 */
export function installDnrPermissionCheck(defaultSession: Session): void {
  setPermissionCheck((extensionId, permission) => {
    if (permission === DNR_PERMISSION) {
      const stripped = strippedPermissionsFor(extensionId)
      return stripped.includes(DNR_PERMISSION) || stripped.includes(DNR_HOST_ACCESS_PERMISSION)
    }
    if (isStrippedPermissionName(permission)) {
      return strippedPermissionsFor(extensionId).includes(permission)
    }
    const extension = defaultSession.extensions.getExtension(extensionId)
    const manifest = extension?.manifest as { permissions?: string[] } | undefined
    return manifest?.permissions?.includes(permission) ?? false
  })
}

function asArray<T>(value: unknown): T[] | undefined {
  return Array.isArray(value) ? (value as T[]) : undefined
}

export function toUpdateRuleOptions(options: unknown): DnrUpdateRuleOptions {
  const record = options !== null && typeof options === 'object' ? (options as Record<string, unknown>) : {}
  const removeRuleIds = asArray<number>(record.removeRuleIds)
  const addRules = asArray<DnrRule>(record.addRules)
  return {
    ...(removeRuleIds !== undefined ? { removeRuleIds } : {}),
    ...(addRules !== undefined ? { addRules } : {}),
  }
}

export function toUpdateRulesetOptions(options: unknown): DnrUpdateRulesetOptions {
  const record = options !== null && typeof options === 'object' ? (options as Record<string, unknown>) : {}
  const enableRulesetIds = asArray<string>(record.enableRulesetIds)
  const disableRulesetIds = asArray<string>(record.disableRulesetIds)
  return {
    ...(enableRulesetIds !== undefined ? { enableRulesetIds } : {}),
    ...(disableRulesetIds !== undefined ? { disableRulesetIds } : {}),
  }
}

interface TestMatchOutcomeRequest {
  readonly url: string
  readonly type: DnrResourceType
  readonly initiator?: string
  readonly method?: string
  readonly tabId?: number
}

export function toDnrRequest(request: TestMatchOutcomeRequest): DnrRequest {
  return {
    url: request.url,
    method: request.method ?? 'get',
    resourceType: request.type,
    ...(request.initiator !== undefined ? { initiator: request.initiator } : {}),
    tabId: request.tabId ?? -1,
    frameId: 0,
  }
}

function engineOrThrow(): DnrEngine {
  const engine = getDnrEngine()
  if (engine === undefined) {
    throw new Error('declarativeNetRequest is not available yet')
  }
  return engine
}

/**
 * Registers every `declarativeNetRequest.*` main-side handler on `router`
 * (the session's own, via `ElectronChromeExtensions.getRouter()`). Returns
 * the two callbacks `dnr-webrequest.ts`'s handlers should call: `onRuleMatched`
 * per matched rule (the action-count badge and `onRuleMatchedDebug`) and
 * `onTabNavigated` per `main_frame` request (zeroes the count a fresh page
 * starts, and blanks the badge of every extension in badge-count mode) --
 * kept separate from registration so a caller that only wants one of the
 * two -- e.g. a unit test -- does not have to fake a whole router.
 */
export function registerDnrApiHandlers(
  router: ExtensionRouterHandle,
  badgeHost: BadgeHost,
  userDataPath: string
): { readonly onRuleMatched: OnRuleMatched, readonly onTabNavigated: OnTabNavigated } {
  const handle = router.apiHandler()
  const gated = { permission: DNR_PERMISSION }

  function persistDynamicRules(extensionId: string): void {
    const slotDir = slotDirForLoadedExtension(userDataPath, extensionId)
    if (slotDir !== undefined) {
      writeDynamicRules(slotDir, engineOrThrow().getDynamicRules(extensionId))
    }
  }

  function persistEnabledRulesets(extensionId: string): void {
    const slotDir = slotDirForLoadedExtension(userDataPath, extensionId)
    if (slotDir !== undefined) {
      writeEnabledRulesetOverride(slotDir, engineOrThrow().getEnabledRulesets(extensionId))
    }
  }

  handle(
    'declarativeNetRequest.updateDynamicRules',
    (event, options: unknown) => {
      engineOrThrow().updateDynamicRules(event.extension.id, toUpdateRuleOptions(options))
      persistDynamicRules(event.extension.id)
    },
    gated
  )

  handle('declarativeNetRequest.getDynamicRules', (event) => engineOrThrow().getDynamicRules(event.extension.id), gated)

  handle(
    'declarativeNetRequest.updateSessionRules',
    (event, options: unknown) => {
      engineOrThrow().updateSessionRules(event.extension.id, toUpdateRuleOptions(options))
    },
    gated
  )

  handle('declarativeNetRequest.getSessionRules', (event) => engineOrThrow().getSessionRules(event.extension.id), gated)

  handle(
    'declarativeNetRequest.updateEnabledRulesets',
    (event, options: unknown) => {
      engineOrThrow().updateEnabledRulesets(event.extension.id, toUpdateRulesetOptions(options))
      persistEnabledRulesets(event.extension.id)
    },
    gated
  )

  handle(
    'declarativeNetRequest.getEnabledRulesets',
    (event) => engineOrThrow().getEnabledRulesets(event.extension.id),
    gated
  )

  handle(
    'declarativeNetRequest.getAvailableStaticRuleCount',
    (event) => engineOrThrow().getAvailableStaticRuleCount(event.extension.id),
    gated
  )

  handle(
    'declarativeNetRequest.isRegexSupported',
    (_event, options: { regex: string, isCaseSensitive?: boolean }) => {
      // This engine's regexFilter matcher is a plain JS RegExp
      // (vendor/firefox-dnr/src/extension-dnr.mjs's compileRegexFilter), not
      // RE2 like Chrome's real one: this answers "does RegExp accept it",
      // not whether Chrome's own (narrower) RE2 syntax or complexity limits
      // would also accept it.
      try {
        // eslint-disable-next-line no-new -- validity check only
        new RegExp(options.regex, options.isCaseSensitive === false ? 'i' : '')
        return { isSupported: true }
      } catch {
        return { isSupported: false, reason: 'syntaxError' }
      }
    },
    gated
  )

  handle(
    'declarativeNetRequest.setExtensionActionOptions',
    (event, options: { displayActionCountAsBadgeText?: boolean, tabUpdate?: { tabId: number, increment: number } }) => {
      if (options.displayActionCountAsBadgeText !== undefined) {
        setDisplayActionCountAsBadgeText(event.extension.id, options.displayActionCountAsBadgeText)
      }
      if (options.tabUpdate !== undefined) {
        incrementActionCount(event.extension.id, options.tabUpdate.tabId, options.tabUpdate.increment)
        // Chrome re-renders the badge the moment this call changes the
        // count, not on the next matched rule -- a caller using tabUpdate to
        // set an initial or corrected count would otherwise see the old
        // badge text until something else happened to trigger a render.
        if (isDisplayActionCountAsBadgeTextEnabled(event.extension.id)) {
          badgeHost.setBadgeText(event.extension.id, options.tabUpdate.tabId, String(getActionCount(event.extension.id, options.tabUpdate.tabId)))
        }
      }
    },
    gated
  )

  // Chrome gates getMatchedRules on declarativeNetRequestFeedback OR
  // activeTab-for-the-requested-tab; only the Feedback branch is
  // implemented here -- Orivon records no per-tab activeTab grant state
  // anywhere in this codebase, so there is nothing yet for the activeTab
  // branch to check. This handler checks permission itself rather than
  // through `gated`.
  handle(
    'declarativeNetRequest.getMatchedRules',
    (event, options?: { tabId?: number }) => {
      if (!strippedPermissionsFor(event.extension.id).includes('declarativeNetRequestFeedback')) {
        throw new Error('declarativeNetRequest.getMatchedRules requires the declarativeNetRequestFeedback permission')
      }
      const matched = getLoggedMatches(event.extension.id, options?.tabId)
      return {
        rulesMatchedInfo: matched.map((entry) => ({
          rule: { ruleId: entry.info.ruleId, rulesetId: entry.info.rulesetId },
          tabId: entry.tabId,
          timeStamp: entry.timestamp,
        })),
      }
    },
    { extensionContext: true }
  )

  handle(
    'declarativeNetRequest.testMatchOutcome',
    (event, request: TestMatchOutcomeRequest) => {
      const matched = engineOrThrow().testMatch(event.extension.id, toDnrRequest(request))
      return { matchedRules: matched.map((info) => ({ ruleId: info.ruleId, rulesetId: info.rulesetId })) }
    },
    gated
  )

  const onRuleMatched: OnRuleMatched = (tabId, info) => {
    const permissions = strippedPermissionsFor(info.extensionId)
    // Chrome's own ActionTracker::OnRuleMatched counts every action type
    // EXCEPT allow/allowAllRequests -- an allow-type match takes no action
    // on the request, so it never moves the badge, even though it is still
    // reported (below) through onRuleMatchedDebug/getMatchedRules like any
    // other match.
    if (info.actionType !== 'allow' && info.actionType !== 'allowAllRequests' && isDisplayActionCountAsBadgeTextEnabled(info.extensionId)) {
      incrementActionCount(info.extensionId, tabId, 1)
      badgeHost.setBadgeText(info.extensionId, tabId, String(getActionCount(info.extensionId, tabId)))
    }
    // Chrome fires onRuleMatchedDebug only for an unpacked (development)
    // extension holding declarativeNetRequestFeedback; this checks the
    // permission only, not the load source -- registry.ts's
    // InstalledExtension.source.kind records "unpacked" already, but
    // strippedPermissionsFor above does not read it, so this event reaches
    // every extension holding the permission, not only an unpacked one.
    if (permissions.includes('declarativeNetRequestFeedback')) {
      router.sendEvent(info.extensionId, 'declarativeNetRequest.onRuleMatchedDebug', {
        rule: { ruleId: info.ruleId, rulesetId: info.rulesetId },
        request: { tabId },
      })
    }
  }

  // Chrome starts a tab's matched-action count over on each new page load
  // (dnr-webrequest.ts's own doc on OnTabNavigated says how a "main_frame
  // request" is detected). Every extension's count for the tab is zeroed
  // regardless of badge-count mode (getActionCount is still real state,
  // declarativeNetRequest.getMatchedRules's own window included); only the
  // ones actually showing it get their badge blanked.
  const onTabNavigated: OnTabNavigated = (tabId) => {
    resetActionCountForTab(tabId)
    for (const extensionId of extensionIdsWithBadgeTextEnabled()) {
      badgeHost.setBadgeText(extensionId, tabId, '')
    }
  }

  return { onRuleMatched, onTabNavigated }
}

/** Exported for tests. */
export function getActionCountForTab(extensionId: string, tabId: number): number {
  return getActionCount(extensionId, tabId)
}
