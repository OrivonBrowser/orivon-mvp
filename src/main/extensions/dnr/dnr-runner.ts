// The thin, Electron-free I/O layer around createDnrEngine(): reads a static
// ruleset's rules from an extension's own loaded folder, and persists
// dynamic rules and the extension's last-chosen enabled-ruleset set to disk.
// Node-only (fs/path); no `electron` import (this directory's README).
// `../extensions-dnr.ts` is the Electron-tied caller that wires this into
// the session's extension lifecycle and `session.defaultSession`;
// `../install-runner.ts`'s `uninstall` calls `clearPersistedRuleState`
// directly, below.

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { writeFileAtomic } from '../../../broker/grants/node-ledger-storage.js'
import type { DnrRule, DnrStaticRuleset } from './types.js'

export interface DnrRuleResource {
  readonly id: string
  readonly enabled: boolean
  readonly path: string
}

/**
 * Validates `declarative_net_request.rule_resources` defensively: it is
 * whatever JSON value the extension's own (untrusted) manifest held before
 * stripping, carried end to end as `unknown`
 * (`registry.ts`'s `StrippedRecord.declarativeNetRequest`). A malformed
 * entry is dropped, not thrown on -- one bad entry must not strand every
 * other ruleset.
 */
export function parseRuleResources(value: unknown): DnrRuleResource[] {
  if (value === null || typeof value !== 'object') {
    return []
  }
  const resources = (value as Record<string, unknown>).rule_resources
  if (!Array.isArray(resources)) {
    return []
  }
  const out: DnrRuleResource[] = []
  for (const entry of resources) {
    if (entry === null || typeof entry !== 'object') {
      continue
    }
    const record = entry as Record<string, unknown>
    if (typeof record.id === 'string' && typeof record.enabled === 'boolean' && typeof record.path === 'string') {
      out.push({ id: record.id, enabled: record.enabled, path: record.path })
    }
  }
  return out
}

function dynamicRulesPath(slotDir: string): string {
  return join(slotDir, 'dnr-dynamic.json')
}

function enabledRulesetsPath(slotDir: string): string {
  return join(slotDir, 'dnr-enabled-rulesets.json')
}

function readJsonArray(path: string): unknown[] | null {
  if (!existsSync(path)) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** `<userData>/extensions/<slot>/dnr-dynamic.json`, `[]` if absent or corrupt. */
export function readDynamicRules(slotDir: string): DnrRule[] {
  return (readJsonArray(dynamicRulesPath(slotDir)) as DnrRule[] | null) ?? []
}

export function writeDynamicRules(slotDir: string, rules: readonly DnrRule[]): void {
  writeFileAtomic(dynamicRulesPath(slotDir), JSON.stringify(rules))
}

/**
 * The enabled-ruleset ids the extension last chose via
 * `updateEnabledRulesets`, or `null` when it never has: falls back to each
 * ruleset's own manifest `enabled` default in that case. Not a Chrome-
 * documented file; this repository's own choice of where to persist it
 * (`<userData>/extensions/<slot>/dnr-enabled-rulesets.json`, alongside
 * `dnr-dynamic.json`).
 */
export function readEnabledRulesetOverride(slotDir: string): string[] | null {
  const parsed = readJsonArray(enabledRulesetsPath(slotDir))
  return parsed !== null && parsed.every((id) => typeof id === 'string') ? (parsed as string[]) : null
}

export function writeEnabledRulesetOverride(slotDir: string, enabledIds: readonly string[]): void {
  writeFileAtomic(enabledRulesetsPath(slotDir), JSON.stringify(enabledIds))
}

/**
 * Deletes `slotDir`'s persisted dynamic rules and enabled-ruleset choice --
 * `install-runner.ts`'s `uninstall` calls this, matching Chrome's own
 * behavior of clearing an extension's dynamic rules on uninstall
 * (`README.md`'s Design notes on where these two files live). Never touches
 * `key.pub`, one level up in the same directory: that file's own job is to
 * survive an uninstall, so a reinstall into the same slot still resolves to
 * the same extension id.
 */
export function clearPersistedRuleState(slotDir: string): void {
  rmSync(dynamicRulesPath(slotDir), { force: true })
  rmSync(enabledRulesetsPath(slotDir), { force: true })
}

/**
 * Reads each static ruleset's rules from `loadedPath` (the extension's own
 * loaded folder), confined to it: `resource.path` comes from the
 * extension's own manifest, so a resolved path that escapes `loadedPath` is
 * refused outright rather than followed. A ruleset whose file is missing,
 * escapes its folder, or is not valid JSON is skipped (empty rules) with a
 * logged reason -- one bad ruleset must not stop every other one from
 * loading, or `createDnrEngine().setStaticRulesets` from being called at
 * all for the rest of this extension's rulesets.
 */
export function loadStaticRulesets(
  loadedPath: string,
  resources: readonly DnrRuleResource[],
  enabledOverride: readonly string[] | null
): DnrStaticRuleset[] {
  const root = resolve(loadedPath)
  return resources.map((resource) => ({
    id: resource.id,
    enabled: enabledOverride !== null ? enabledOverride.includes(resource.id) : resource.enabled,
    rules: readRulesetFile(root, resource),
  }))
}

function readRulesetFile(root: string, resource: DnrRuleResource): DnrRule[] {
  // Chrome's rule_resources[].path is documented relative to the
  // extension's own root (an extension conventionally spells it
  // "/rulesets/main/x.json", per Chrome's own examples): a LEADING slash
  // means "the extension root", never the filesystem root, so it is
  // stripped before joining -- node:path's own resolve() would otherwise
  // treat it as absolute and discard `root` entirely, which would make the
  // very next check (does it escape `root`) meaningless.
  const relativePath = resource.path.startsWith('/') ? resource.path.slice(1) : resource.path
  const resolved = resolve(root, relativePath)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    console.error(`[dnr] ruleset "${resource.id}" path escapes its extension folder, skipped: ${resource.path}`)
    return []
  }
  if (!existsSync(resolved)) {
    console.error(`[dnr] ruleset "${resource.id}" file not found, skipped: ${resource.path}`)
    return []
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolved, 'utf8'))
    return Array.isArray(parsed) ? (parsed as DnrRule[]) : []
  } catch (error) {
    console.error(`[dnr] ruleset "${resource.id}" is not valid JSON, skipped: ${String(error)}`)
    return []
  }
}
