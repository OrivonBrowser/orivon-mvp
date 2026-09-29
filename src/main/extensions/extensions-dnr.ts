// Attaches one DnrEngine to session.defaultSession's real extension
// lifecycle. Must run before the first `loadExtension()` call reaches that
// session (../extensions-subsystem.ts's own ordering requirement for the
// library's router listener, extension-host.ts's header -- the same
// requirement applies here: an 'extension-loaded' event this listener
// missed never fires again), so extensions-subsystem.ts calls
// `attachExtensionsDnr` right after `createExtensionHost()`, before
// `loadEnabledExtensions()`.

import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Session } from 'electron'
import { createDnrEngine, type DnrEngine } from './dnr/dnr-engine.js'
import { loadStaticRulesets, parseRuleResources, readDynamicRules, readEnabledRulesetOverride } from './dnr/dnr-runner.js'
import { buildActionAccess } from './dnr/host-permissions.js'
import { readExtensionManifest } from '../../broker/policy/extension-manifest.js'
import { readRegistry } from './registry-runner.js'
import type { InstalledExtension } from './registry.js'
import { clearExtensionMatchLog } from './dnr-match-log.js'

/** Chrome requires either permission for `chrome.declarativeNetRequest` to
 * exist at all; `declarativeNetRequestFeedback` alone (no base permission)
 * grants nothing by itself. */
function hasDnrPermission(stripped: InstalledExtension['stripped']): boolean {
  return (
    stripped.permissions.includes('declarativeNetRequest') ||
    stripped.permissions.includes('declarativeNetRequestWithHostAccess')
  )
}

/**
 * The host match patterns `buildActionAccess` (below) should gate this
 * extension's `redirect`/`modifyHeaders` rules on, read from the LOADED
 * manifest.json on disk: `loadableManifest` strips `declarativeNetRequest*`/
 * `webRequest*` permissions and the `declarative_net_request` key, but never
 * touches `host_permissions` or `content_scripts`, so the loaded copy's own
 * host patterns are exactly the original's. The one call site (`loadExtensionIntoEngine`,
 * below) is deliberately funneled through this single function: `readExtensionManifest`'s
 * `hostPatterns` fact currently includes content-script match patterns, not
 * only `host_permissions`, which a separate change is giving its own
 * explicit `hostPermissions` fact -- swapping this function's `parsed.facts.hostPatterns`
 * read for `parsed.facts.hostPermissions` will be the entire change needed
 * here once that fact exists.
 */
function hostAccessPatternsFor(entry: InstalledExtension): readonly string[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(entry.path, 'manifest.json'), 'utf8'))
    const parsed = readExtensionManifest(raw)
    return parsed.ok ? parsed.facts.hostPatterns : []
  } catch (error) {
    console.error(`[dnr] ${entry.id}: could not read its own loaded manifest.json for host patterns: ${String(error)}`)
    return []
  }
}

/** `<userData>/extensions/<slot>/`, given the versioned loaded path
 * (`<slot>/<version>/`) a registry entry carries -- see `dnr/README.md`'s
 * Design notes on why `dnr-dynamic.json`/`dnr-enabled-rulesets.json` live
 * one level up from `entry.path`. */
function slotDirFor(entry: InstalledExtension): string {
  return dirname(entry.path)
}

function loadExtensionIntoEngine(engine: DnrEngine, entry: InstalledExtension): void {
  if (!hasDnrPermission(entry.stripped)) {
    return
  }

  engine.setActionAccess(entry.id, buildActionAccess(entry.stripped.permissions, hostAccessPatternsFor(entry)))

  const slotDir = slotDirFor(entry)
  const resources = parseRuleResources(entry.stripped.declarativeNetRequest)
  const enabledOverride = readEnabledRulesetOverride(slotDir)
  try {
    engine.setStaticRulesets(entry.id, loadStaticRulesets(entry.path, resources, enabledOverride))
  } catch (error) {
    console.error(`[dnr] ${entry.id}: static rulesets rejected, none loaded: ${String(error)}`)
  }

  const dynamicRules = readDynamicRules(slotDir)
  if (dynamicRules.length > 0) {
    try {
      engine.updateDynamicRules(entry.id, { addRules: dynamicRules })
    } catch (error) {
      console.error(`[dnr] ${entry.id}: persisted dynamic rules rejected, none loaded: ${String(error)}`)
    }
  }
}

let engine: DnrEngine | undefined

/** The engine `attachExtensionsDnr` created, for `dnr-api.ts`/`dnr-webrequest.ts`.
 * `undefined` before `attachExtensionsDnr` runs (there is exactly one
 * default session, so exactly one engine, for the lifetime of the
 * process). */
export function getDnrEngine(): DnrEngine | undefined {
  return engine
}

/** Loaded extensions currently holding `declarativeNetRequest`/
 * `...WithHostAccess` -- `dnr-webrequest.ts`'s own reason for tracking this:
 * it registers on the default session's webRequest only while this is
 * non-empty, and unregisters when it empties (`../sessions/README.md`'s own
 * Design notes on `WebRequestHandlerHandle`). */
let dnrCapableExtensions = new Set<string>()
type DnrActiveListener = (active: boolean) => void
let activeListeners: DnrActiveListener[] = []

/** Loaded extensions currently holding `declarativeNetRequestFeedback` --
 * `dnr-webrequest.ts`'s own reason for tracking this: Chrome only ever
 * records a matched rule for `getMatchedRules`/`onRuleMatchedDebug` when the
 * extension holds this permission (or, unimplemented here, `activeTab` for
 * the request's own tab -- `dnr-api.ts`'s `getMatchedRules` handler doc).
 * `dnr-webrequest.ts` skips the match-log bookkeeping entirely while this is
 * empty AND no extension is in badge-count mode, so a person with neither
 * pays no per-match log-array cost. */
let feedbackCapableExtensions = new Set<string>()

/** Every loaded extension's ORIGINAL (pre-strip) permission list, keyed by
 * id -- `dnr-api.ts`'s `strippedPermissionsFor` reads this instead of
 * re-reading and re-parsing `registry.json` on every matched rule
 * (`dnr-webrequest.ts` calls it once per matched rule on the hot
 * `onBeforeRequest` path). Populated on `'extension-loaded'`, dropped on a
 * real `'extension-unloaded'` -- kept across a recovery reload, same as
 * everything else `reloadingIds` protects below. */
let strippedPermissionsCache = new Map<string, readonly string[]>()

/** Extension ids install-runner.ts's `finishInstall` has handed a fresh
 * `InstalledExtension` for, ahead of the `loadExtension()` call that is
 * about to fire `'extension-loaded'` for the same id -- see
 * `registerPendingDnrInstall`'s own doc. */
let pendingInstallEntries = new Map<string, InstalledExtension>()

/** Extension ids currently mid a recovery reload (`extension-sw-preload-
 * recovery.ts`'s remove-then-load, marked around it via `beginDnrReload`/
 * `endDnrReload`) -- see `beginDnrReload`'s own doc. */
let reloadingIds = new Set<string>()

function notifyDnrActive(): void {
  const active = dnrCapableExtensions.size > 0
  for (const listener of activeListeners) {
    listener(active)
  }
}

/** Subscribes to whether ANY loaded extension currently holds a
 * `declarativeNetRequest*` permission -- fires once immediately with the
 * current answer, then again every time it changes. `dnr-webrequest.ts` is
 * the one subscriber: it registers its three webRequest handlers only while
 * this is true, so a person with no such extension loaded pays no webRequest
 * round trip at all. */
export function onDnrActiveChange(listener: DnrActiveListener): void {
  activeListeners.push(listener)
  listener(dnrCapableExtensions.size > 0)
}

/** Whether any loaded extension currently holds `declarativeNetRequestFeedback`
 * -- `dnr-webrequest.ts`'s own half of the match-log recording gate
 * (`feedbackCapableExtensions`'s own doc; the other half,
 * `hasAnyBadgeCountModeEnabled`, is `dnr-match-log.ts`'s). */
export function hasFeedbackCapableExtension(): boolean {
  return feedbackCapableExtensions.size > 0
}

/** `extensionId`'s ORIGINAL (pre-strip) permission list, `[]` if it is not
 * currently loaded -- `dnr-api.ts`'s own cache read, see
 * `strippedPermissionsCache`'s own doc. */
export function getCachedStrippedPermissions(extensionId: string): readonly string[] {
  return strippedPermissionsCache.get(extensionId) ?? []
}

/**
 * Hands the dNR service the `InstalledExtension` `install-runner.ts`'s
 * `finishInstall` is ABOUT to load, before it calls `loadExtension` --
 * without this, the `'extension-loaded'` listener below would look the
 * extension up in `registry.json` and find either nothing at all (a fresh
 * install: `finishInstall` does not call `writeRegistry` until after the
 * load resolves) or the OLD entry (an update: the OLD registry entry for
 * this slot is still there until the same `writeRegistry` call), so a
 * freshly installed or updated extension's dNR rules would not take effect
 * until the next restart. The `'extension-loaded'` listener consumes (reads
 * and deletes) whatever entry is registered for the id it fires for,
 * falling back to `registry.json` only when nothing was registered -- the
 * ordinary boot-time load path (`extensions-subsystem.ts`'s
 * `loadEnabledExtensions`) and `install-runner.ts`'s `setEnabled` never call
 * this, so they still resolve through the registry exactly as before.
 */
export function registerPendingDnrInstall(entry: InstalledExtension): void {
  pendingInstallEntries.set(entry.id, entry)
}

/**
 * Undoes `registerPendingDnrInstall` for an install that failed before
 * `'extension-loaded'` ever fired for it -- `install-runner.ts`'s
 * `finishInstall` calls this on a failed `loadExtension`, before
 * `restoreAsideOnFailure` may reload the PREVIOUS version under the SAME id
 * (an update reinstalls into the same slot, so the id does not change): a
 * leftover pending entry for the new, failed version would otherwise be
 * mistaken for the old version `'extension-loaded'` is about to fire for.
 */
export function clearPendingDnrInstall(id: string): void {
  pendingInstallEntries.delete(id)
}

/**
 * Marks `id` as mid a recovery reload -- `extension-sw-preload-
 * recovery.ts`'s own remove-then-load, called once to recover a missed
 * service-worker preload, NOT a real disable/uninstall/update. While marked,
 * the `'extension-unloaded'` handler below does none of its usual teardown
 * (it does not drop the engine's rule manager, so session rules survive; it
 * does not clear the match log's badge mode or action counts; it does not
 * remove the id from `dnrCapableExtensions`, so `dnr-webrequest.ts` never
 * briefly unregisters its webRequest handlers for the gap between the
 * remove and the load). `endDnrReload` unmarks it -- the paired
 * `'extension-loaded'` still runs its ordinary work (refreshing the
 * engine's static/dynamic rules and action access from disk), which is
 * idempotent and touches none of the state this protects.
 */
export function beginDnrReload(id: string): void {
  reloadingIds.add(id)
}

/** Ends what `beginDnrReload` started -- always call this once the reload's
 * `loadExtension` has settled, success or failure, or `id` would keep
 * suppressing `'extension-unloaded'` teardown forever. */
export function endDnrReload(id: string): void {
  reloadingIds.delete(id)
}

/**
 * `entry.path` for `extensionId`, looked up fresh from the registry --
 * `dnr-api.ts`'s handlers need it to persist a runtime change
 * (`updateDynamicRules`, `updateEnabledRulesets`) to the same slot this
 * function loaded it from at boot/load time.
 */
export function slotDirForLoadedExtension(userDataPath: string, extensionId: string): string | undefined {
  const entry = readRegistry(userDataPath).find((candidate) => candidate.id === extensionId)
  return entry === undefined ? undefined : slotDirFor(entry)
}

function trackLoadedEntry(dnrEngine: DnrEngine, entry: InstalledExtension): void {
  strippedPermissionsCache.set(entry.id, entry.stripped.permissions)
  if (entry.stripped.permissions.includes('declarativeNetRequestFeedback')) {
    feedbackCapableExtensions.add(entry.id)
  } else {
    feedbackCapableExtensions.delete(entry.id)
  }
  loadExtensionIntoEngine(dnrEngine, entry)
  if (hasDnrPermission(entry.stripped)) {
    dnrCapableExtensions.add(entry.id)
    notifyDnrActive()
  }
}

export function attachExtensionsDnr(defaultSession: Session, userDataPath: string): DnrEngine {
  const dnrEngine = createDnrEngine()
  engine = dnrEngine
  dnrCapableExtensions = new Set()
  feedbackCapableExtensions = new Set()
  strippedPermissionsCache = new Map()
  pendingInstallEntries = new Map()
  reloadingIds = new Set()
  activeListeners = []

  const sessionExtensions = defaultSession.extensions
  sessionExtensions.on('extension-loaded', (_event, extension) => {
    const pending = pendingInstallEntries.get(extension.id)
    pendingInstallEntries.delete(extension.id)
    const entry = pending ?? readRegistry(userDataPath).find((candidate) => candidate.id === extension.id)
    if (entry !== undefined) {
      trackLoadedEntry(dnrEngine, entry)
    }
  })
  sessionExtensions.on('extension-unloaded', (_event, extension) => {
    if (reloadingIds.has(extension.id)) {
      return
    }
    dnrEngine.removeExtension(extension.id)
    clearExtensionMatchLog(extension.id)
    strippedPermissionsCache.delete(extension.id)
    feedbackCapableExtensions.delete(extension.id)
    if (dnrCapableExtensions.delete(extension.id)) {
      notifyDnrActive()
    }
  })

  return dnrEngine
}
