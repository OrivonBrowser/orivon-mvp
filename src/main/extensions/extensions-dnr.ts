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

/** `readExtensionManifest`'s `hostPatterns` fact, read from the LOADED
 * manifest.json on disk: `loadableManifest` strips `declarativeNetRequest*`/
 * `webRequest*` permissions and the `declarative_net_request` key, but never
 * touches `host_permissions` or `content_scripts`, so the loaded copy's own
 * host patterns are exactly the original's. */
function hostPatternsFor(entry: InstalledExtension): readonly string[] {
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

  engine.setActionAccess(entry.id, buildActionAccess(entry.stripped.permissions, hostPatternsFor(entry)))

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

export function attachExtensionsDnr(defaultSession: Session, userDataPath: string): DnrEngine {
  const dnrEngine = createDnrEngine()
  engine = dnrEngine

  const sessionExtensions = defaultSession.extensions
  sessionExtensions.on('extension-loaded', (_event, extension) => {
    const entry = readRegistry(userDataPath).find((candidate) => candidate.id === extension.id)
    if (entry !== undefined) {
      loadExtensionIntoEngine(dnrEngine, entry)
    }
  })
  sessionExtensions.on('extension-unloaded', (_event, extension) => {
    dnrEngine.removeExtension(extension.id)
    clearExtensionMatchLog(extension.id)
  })

  return dnrEngine
}
