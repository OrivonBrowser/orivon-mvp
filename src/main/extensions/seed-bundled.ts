// The extensions that ship with Orivon: installed, from their unpacked folders, into a profile that has never installed one,
// and followed to the folder of the Orivon that runs on every start after.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bundledExtensions, parseBundledExtensions } from '../default-profile/default-profile.js'
import { loadableManifest, readExtensionManifest } from '../../broker/policy/extension-manifest.js'
import { isString, ownProperty } from '../../broker/policy/own-property.js'
import { generateId } from '../../../vendor/electron-chrome-web-store/src/browser/id.js'
import { bundledRecordFile, readBundledRecord, type BundledRecord } from './bundled-folder.js'
import { installBundled, type InstallContext } from './install-runner.js'
import { canonicalizeManifestKey, readRegistry, writeRegistry } from './registry-runner.js'
import { registerPendingInstalled } from './runtime-installed.js'
import type { InstalledExtension } from './registry.js'

const logger = (problem: string): void => { console.error(`[extensions] bundled: ${problem}`) }

/** One extension that fails to install is logged and the rest still go in: the browser starts either way. */
export async function seedBundledExtensions (install: InstallContext, dir: string): Promise<void> {
  for (const extension of await bundledExtensions(dir, logger)) {
    const record = readBundledRecord(dirname(extension.path), extension.folder)
    if (record === undefined) {
      logger(`${extension.name} was not installed: ${bundledRecordFile(extension.folder)} is missing (node scripts/fetch-bundled-extensions.mjs unpacks it)`)
      continue
    }
    try {
      const outcome = await installBundled(install, { folder: extension.folder, path: extension.path, record }, { pinned: extension.pinned })
      if (!outcome.installed) logger(`${extension.name} was not installed: ${outcome.reason}`)
    } catch (error) {
      logger(`${extension.name} was not installed: ${String(error)}`)
    }
  }
}

/** `entry`, made to describe the folder its extension is loaded from now: undefined when the folder's record is not that extension's. */
function following (entry: InstalledExtension, path: string, record: BundledRecord): InstalledExtension | undefined {
  const parsed = readExtensionManifest(record.manifest)
  const key = ownProperty(record.manifest, 'key', isString)
  const canonical = key === undefined ? undefined : canonicalizeManifestKey(key)
  if (!parsed.ok || canonical === undefined || generateId(canonical) !== entry.id) return undefined
  const { name, version } = parsed.facts
  if (entry.path === path && entry.version === version && entry.name === name) return entry
  if (entry.enabled && entry.version !== version) registerPendingInstalled(entry.id, { reason: 'update', previousVersion: entry.version })
  return { ...entry, path, name, version, updatedAt: entry.version === version ? entry.updatedAt : Date.now(), stripped: loadableManifest(record.manifest).stripped }
}

/**
 * Runs before the extensions load, on every start. An extension of the registry that came with Orivon (`source.kind ===
 * 'bundled'`) is loaded from a folder of the application, so its entry takes that folder's place (a package that is
 * mounted somewhere new at each start, the AppImage, moves it) and its version (an Orivon that brings a newer one brings
 * it here). An extension the person installed over it, removed or switched off is left as it is: only an entry that still
 * says it is bundled follows, and one that is not in the registry is never added. Synchronous and small: the registry,
 * the list and one record per bundled extension. Never throws.
 */
export function refreshBundledExtensions (userDataPath: string, dir: string): void {
  try {
    const registry = readRegistry(userDataPath)
    if (!registry.some((entry) => entry.source.kind === 'bundled')) return
    const listed = parseBundledExtensions(readFileSync(join(dir, 'bundled-extensions.json'), 'utf8'), dir, logger)
    let changed = false
    const next = registry.map((entry) => {
      if (entry.source.kind !== 'bundled') return entry
      const { folder } = entry.source
      const item = listed.find((candidate) => candidate.folder === folder)
      const record = item === undefined ? undefined : readBundledRecord(dirname(item.path), folder)
      if (item === undefined || record === undefined) return entry
      const refreshed = following(entry, item.path, record)
      if (refreshed === undefined) {
        logger(`${entry.name} is not the extension in ${item.path}: it keeps the folder it has`)
        return entry
      }
      if (refreshed !== entry) changed = true
      return refreshed
    })
    if (changed) writeRegistry(userDataPath, next)
  } catch (error) {
    logger(`the bundled extensions could not be brought up to date: ${String(error)}`)
  }
}
