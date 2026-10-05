// Installs an extension from an unpacked folder, a `.crx` file or a `.zip`
// file: reads its manifest, shows the install prompt, writes the loaded
// copy, loads it into the session, and records it in the registry. I/O
// (`-runner.ts`, src/main/README.md's suffix rule) -- the prompt itself is
// injected (`InstallPrompt`), so this file is testable with a fake one,
// matching `src/main/install/app-install.ts`'s own split from its real
// dialog. Web Store installs and updates are install-store-runner.ts;
// uninstall and enable/disable are install-lifecycle.ts.

import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type { Session } from 'electron'
import {
  describeExtensionInstall, loadableManifest, readExtensionManifest,
  type ExtensionInstallDescription, type ExtensionInstallSource
} from '../../broker/policy/extension-manifest.js'
import { isString, ownProperty } from '../../broker/policy/own-property.js'
import { verifyCrx3 } from './crx.js'
import { peekManifest, readManifestObject, unpackZip, writeFolderCopy, writeManifestOver } from './unpack-runner.js'
import {
  canonicalizeManifestKey, readRegistry, resolveInstallKey, slotOfFileEntry, withRegistryLock, writeRegistry
} from './registry-runner.js'
import type { ExtensionSource, ExtensionUpdater, InstalledExtension } from './registry.js'
import { clearPendingDnrInstall, registerPendingDnrInstall } from './extensions-dnr.js'
import { clearPendingInstalled, registerPendingInstalled } from './runtime-installed.js'
import { effectiveManifest, manifestText } from './effective-manifest.js'
import { reconcileGrants } from './granted-reconcile.js'
import type { ExtensionPrefsStore } from './extension-prefs.js'
import { readBaseManifestText, restoreBaseManifest, writeBaseManifest } from './effective-manifest-runner.js'
import { refusePrivateInstall } from './install-private.js'
import { takeEnabledRulesetOverride, writeEnabledRulesetOverride } from './dnr/dnr-runner.js'
import { generateId } from '../../../vendor/electron-chrome-web-store/src/browser/id.js'

// resolveSlotKey moved to registry-runner.ts (key.pub is persisted
// bookkeeping under <userData>/extensions/, the same concern registry.json
// itself is) -- re-exported here since e2e fixtures and test/
// extensions-fixtures.ts import it from this file's own public surface.
export { resolveSlotKey } from './registry-runner.js'

/** `where.contents` is the page the person asked from, when one did: the question is drawn in its tab. Without it the question goes to the tab in front. */
export type InstallWhere = { readonly contents?: object | undefined }
export type InstallPrompt = (description: ExtensionInstallDescription, where?: InstallWhere) => Promise<boolean>

export interface InstallContext {
  readonly userDataPath: string
  readonly session: Session
  readonly prompt: InstallPrompt
  /** What the person chose per extension; with it, a new version loads with those choices already applied. */
  readonly prefs?: ExtensionPrefsStore
  /** This runtime is private or a guest: every install route refuses (install-private.ts). */
  readonly privateSession?: boolean
  /** Empties the loaded extension's chrome.storage; an uninstall runs it first (extension-data.ts). */
  readonly clearExtensionStorage?: (id: string) => Promise<void>
  /** Closes every side panel the extension has open, so none writes storage back; an uninstall runs it before `clearExtensionStorage`. */
  readonly closeSidePanels?: (id: string) => Promise<void>
}

export type InstallOutcome =
  | { readonly installed: true, readonly entry: InstalledExtension }
  | { readonly installed: false, readonly reason: string }

function extensionsRoot (userDataPath: string): string {
  return join(userDataPath, 'extensions')
}

function slotHash (input: Buffer): string {
  return `u-${createHash('sha256').update(input).digest('hex').slice(0, 16)}`
}

/**
 * True when `child` resolves to a path strictly inside `parent` -- the same
 * shape `unpack-runner.ts`'s `checkZipEntryPath` applies to a zip entry
 * name, applied here to the slot and version-numbered directories
 * `finishInstall` is about to write into. This check is independent of
 * `readExtensionManifest`'s own `version` grammar (`extension-manifest.ts`):
 * that grammar already refuses a `version` shaped like a path, but this
 * function is the layer that holds even if a future caller, or a bug in
 * that grammar, ever let one through.
 */
export function isStrictlyInsideDirectory (parent: string, child: string): boolean {
  const resolvedParent = resolve(parent)
  const resolvedChild = resolve(child)
  return resolvedChild !== resolvedParent && resolvedChild.startsWith(resolvedParent + sep)
}

/** The slot of the existing `source.kind === 'file'` registry entry whose
 * id matches `rawManifest`'s own (canonicalized) `key` -- `undefined` when
 * `rawManifest` carries no key, the key does not parse, or no such entry
 * exists. */
function slotForZipUpdate (userDataPath: string, rawManifest: Record<string, unknown>): string | undefined {
  const manifestKey = ownProperty(rawManifest, 'key', isString)
  if (manifestKey === undefined) return undefined
  const canonical = canonicalizeManifestKey(manifestKey)
  if (canonical === undefined) return undefined
  return slotOfFileEntry(userDataPath, generateId(canonical))
}

export interface PendingInstall {
  readonly rawManifest: Record<string, unknown>
  readonly source: ExtensionSource
  readonly updater: ExtensionUpdater
  readonly slot: string
  /** A `.crx`'s developer public key (crx.ts's own doc) -- `undefined` for
   * a folder or `.zip` install, which carries no signature at all. */
  readonly developerPublicKey?: Buffer
  /** Skips this function's own prompt below: the caller already showed one
   * (the store page's own `beforeInstall` hook, for a fresh store install;
   * nothing at all, for a silent background update this function is about
   * to refuse anyway if it widens what is granted) -- installFromStoreCrx's
   * own doc says which of its callers sets this and which does not. */
  readonly preApproved?: boolean
  /** Writes the loaded copy at `targetDir`, with `manifestJson` (already
   * carrying its resolved `key`) in place of `manifest.json` -- everything
   * install-runner.ts's caller-specific step (folder copy, or the
   * already-downloaded archive) needed to know. */
  readonly write: (targetDir: string, manifestJson: string) => void
}

export async function finishInstall (ctx: InstallContext, pending: PendingInstall, where?: InstallWhere): Promise<InstallOutcome> {
  const refused = refusePrivateInstall(ctx)
  if (refused !== undefined) return refused
  const manifestResult = readExtensionManifest(pending.rawManifest)
  if (!manifestResult.ok) return { installed: false, reason: `manifest refused: ${manifestResult.reason}` }
  const { facts } = manifestResult

  const description = describeExtensionInstall(facts, pending.source.kind as ExtensionInstallSource)
  const allowed = pending.preApproved === true || await ctx.prompt(description, where)
  if (!allowed) return { installed: false, reason: 'declined by the person' }

  const { manifest, stripped } = loadableManifest(pending.rawManifest)
  const manifestKey = ownProperty(pending.rawManifest, 'key', isString)
  const keyResult = resolveInstallKey(ctx.userDataPath, pending.slot, pending.developerPublicKey, manifestKey)
  if (!keyResult.ok) return { installed: false, reason: `install refused: ${keyResult.reason}` }
  const key = keyResult.key
  manifest.key = key
  const id = generateId(key)

  // Matched by SLOT, the directory the versions of one install live under
  // (README.md's Design notes); the key resolved above makes `id` stable
  // per slot as well.
  const slotDir = join(extensionsRoot(ctx.userDataPath), pending.slot)
  if (!isStrictlyInsideDirectory(extensionsRoot(ctx.userDataPath), slotDir)) {
    return { installed: false, reason: 'install refused: slot resolves outside the extensions directory' }
  }
  const registry = readRegistry(ctx.userDataPath)
  const previousInSlot = registry.filter((existing) => existing.path.startsWith(`${slotDir}${sep}`))

  // An id belongs to at most one slot. resolveInstallKey above already stops
  // a signed .crx's manifest `key` from smuggling another extension's id
  // into this slot, but a folder or `.zip` install still trusts its own
  // manifest `key` outright -- refused here, before anything is written, so
  // the registry never ends up with two entries sharing one id.
  const usedInAnotherSlot = registry.some((existing) => existing.id === id && !previousInSlot.includes(existing))
  if (usedInAnotherSlot) return { installed: false, reason: 'another installed extension already uses this id' }

  const targetDir = join(extensionsRoot(ctx.userDataPath), pending.slot, facts.version)
  // Independent of readExtensionManifest's own version grammar
  // (extension-manifest.ts) -- see isStrictlyInsideDirectory's own doc.
  if (!isStrictlyInsideDirectory(slotDir, targetDir)) {
    return { installed: false, reason: 'install refused: version resolves outside its own slot directory' }
  }

  // The old version, if this slot's id is currently loaded, is removed
  // BEFORE anything on disk changes -- Electron never holds two loaded
  // extensions under the same id at once, and a same-version reinstall
  // below must free the old folder (locked while loaded, especially on
  // Windows) before it can be moved aside. A load failure later on is
  // recovered by reloading the same previous version back, so a person
  // never ends up with neither.
  // Electron answers null for an id it does not hold; the tests' fake answers undefined.
  const loadedNow = ctx.session.extensions.getExtension(id)
  const wasLoaded = loadedNow != null
  if (wasLoaded) ctx.session.extensions.removeExtension(id)

  // A same-version reinstall (Developer mode's Reload with no version bump,
  // or a same-version store reinstall) targets its own previous folder:
  // moved aside first, so `pending.write`'s own tmp-dir-then-rename never
  // lands on a non-empty targetDir (unpack-runner.ts's own doc: it "must not
  // already exist").
  // The installed manifest, kept apart from the loaded copy (which carries the person's choices).
  const previousBase = readBaseManifestText(slotDir)
  const baseText = manifestText(manifest)
  if (ctx.prefs !== undefined) reconcileGrants(ctx.prefs, id, manifest)
  const loadedText = ctx.prefs === undefined ? baseText : manifestText(effectiveManifest(manifest, ctx.prefs.get(id)))

  // Set when the update drops the enabled-ruleset choice below, for a failed load to put back.
  let droppedRulesetChoice: string[] | null = null

  const asideDir = existsSync(targetDir) ? `${targetDir}.old-${randomBytes(6).toString('hex')}` : undefined
  if (asideDir !== undefined) renameSync(targetDir, asideDir)

  /** Undoes the move above: whatever `targetDir` holds now (nothing, or a
   * partially or fully written new copy) is discarded, the old folder comes
   * back, and -- if it was loaded before this call started -- it is loaded
   * again, so a failed reinstall never leaves the slot with neither copy.
   * A FRESH install (no previous version in this slot, `asideDir`
   * undefined) has no old folder to restore, but its own just-written
   * `targetDir` is still removed here -- otherwise a write that succeeded
   * followed by a load (or anything after the write) that failed left that
   * folder behind for the next boot to find, unregistered and never
   * cleaned up. */
  async function restoreAsideOnFailure (): Promise<void> {
    restoreBaseManifest(slotDir, previousBase)
    if (droppedRulesetChoice !== null) writeEnabledRulesetOverride(slotDir, droppedRulesetChoice)
    if (asideDir === undefined) {
      rmSync(targetDir, { recursive: true, force: true })
      const previous = previousInSlot[0]
      if (wasLoaded && previous !== undefined) {
        await ctx.session.extensions.loadExtension(previous.path, { allowFileAccess: false })
      }
      return
    }
    rmSync(targetDir, { recursive: true, force: true })
    renameSync(asideDir, targetDir)
    if (wasLoaded) await ctx.session.extensions.loadExtension(targetDir, { allowFileAccess: false })
  }

  try {
    writeBaseManifest(slotDir, baseText)
    pending.write(targetDir, loadedText)
  } catch (error) {
    await restoreAsideOnFailure()
    throw error
  }

  const now = Date.now()
  const replaced = previousInSlot.find((existing) => existing.id === id)
  // An update or reinstall keeps the person's choice: a disabled extension is written and registered, never loaded.
  const enabled = replaced?.enabled ?? true
  const entry: InstalledExtension = {
    id,
    name: facts.name,
    version: facts.version,
    enabled,
    installedAt: replaced?.installedAt ?? now,
    updatedAt: now,
    source: pending.source,
    updater: pending.updater,
    path: targetDir,
    stripped
  }

  // A new version starts from the rulesets its manifest enables; the dynamic rules stay.
  if (enabled && replaced !== undefined && replaced.version !== facts.version) droppedRulesetChoice = takeEnabledRulesetOverride(slotDir)

  if (enabled) {
    // Handed to the declarativeNetRequest service BEFORE loadExtension: the
    // registry write below only lands after the load resolves, so its own
    // 'extension-loaded' listener would otherwise find no entry (a fresh
    // install) or the previous one (an update). extensions-dnr.ts has the
    // full account.
    registerPendingDnrInstall(entry)
    // Parked before the load because the extension's worker starts during it and asks once.
    registerPendingInstalled(id, replaced === undefined ? { reason: 'install' } : { reason: 'update', previousVersion: replaced.version })

    let loaded: Awaited<ReturnType<Session['extensions']['loadExtension']>>
    try {
      loaded = await ctx.session.extensions.loadExtension(targetDir, { allowFileAccess: false })
    } catch (error) {
      // Left in place, the pending entry would be taken for the previous
      // version that restoreAsideOnFailure may reload under this same id.
      clearPendingDnrInstall(id)
      clearPendingInstalled(id)
      await restoreAsideOnFailure()
      throw error
    }

    // Belt and suspenders on top of resolveInstallKey's own canonicalization:
    // Electron derives its own id from the manifest `key` this function just
    // wrote, independently of the `id` this function computed for its own
    // slot/registry bookkeeping above. The two must agree, or the copy just
    // loaded is rolled back the same way a failed load is -- an id that
    // slipped past canonicalization some other way must never be registered
    // under a name it does not actually run as.
    if (loaded.id !== id) {
      clearPendingDnrInstall(id)
      clearPendingInstalled(id)
      ctx.session.extensions.removeExtension(loaded.id)
      // Loading under an installed extension's id replaced it in the session: load that one back.
      const displaced = readRegistry(ctx.userDataPath).find((existing) => existing.id === loaded.id && existing.enabled)
      if (displaced !== undefined) {
        await ctx.session.extensions.loadExtension(displaced.path, { allowFileAccess: false })
          .catch((error: unknown) => { console.error('[extensions] could not reload the extension a refused install displaced', displaced.id, error) })
      }
      await restoreAsideOnFailure()
      return { installed: false, reason: 'install refused: the loaded extension\'s id does not match its resolved key' }
    }
  }

  // Re-reads the registry inside the lock rather than reusing the `registry`
  // read at the top of this function -- concurrent installs, uninstalls and
  // updater checks (registry-runner.ts's own doc on `withRegistryLock`)
  // resolve to at most one holder at a time, so this call's own change never
  // overwrites one that landed on the registry while `pending.write` and
  // `loadExtension` above were running.
  await withRegistryLock(ctx.userDataPath, (freshRegistry) => {
    const stillPreviousInSlot = freshRegistry.filter((existing) => existing.path.startsWith(`${slotDir}${sep}`))
    const kept = freshRegistry.filter((existing) => !stillPreviousInSlot.includes(existing))
    writeRegistry(ctx.userDataPath, [...kept, entry])
  })

  // Only after the new version has actually loaded and been registered
  // (README.md's Design notes): a failure above already restored the old
  // folder and returned early, leaving every OLD folder and registry entry
  // untouched.
  for (const previous of previousInSlot) {
    if (previous.path !== entry.path) rmSync(previous.path, { recursive: true, force: true })
  }
  if (asideDir !== undefined) rmSync(asideDir, { recursive: true, force: true })

  return { installed: true, entry }
}

/** Installs an unpacked extension from a folder the person picked. */
export async function installFromFolder (ctx: InstallContext, dir: string, where?: InstallWhere): Promise<InstallOutcome> {
  const refused = refusePrivateInstall(ctx)
  if (refused !== undefined) return refused
  const rawManifest = readManifestObject(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')), dir)
  return await finishInstall(ctx, {
    rawManifest,
    source: { kind: 'unpacked', from: dir },
    updater: { kind: 'none', reason: 'unpacked extensions have no update mechanism' },
    slot: slotHash(Buffer.from(dir)),
    write: (targetDir, manifestJson) => { writeFolderCopy(dir, targetDir, manifestJson) }
  }, where)
}

/**
 * Installs from a `.crx` or `.zip` file the person picked. A `.crx` is
 * verified with `requirePublisherProof: false` -- a local file need not
 * have come from the Chrome Web Store, so only the developer proof
 * (crx.ts's own doc) is required. A `.zip` carries no signature at all: its
 * slot is derived from the file's own bytes, never from a claimed identity.
 */
export async function installFromFile (ctx: InstallContext, filePath: string, where?: InstallWhere): Promise<InstallOutcome> {
  const refused = refusePrivateInstall(ctx)
  if (refused !== undefined) return refused
  const bytes = Buffer.from(readFileSync(filePath))
  const isCrx = extname(filePath).toLowerCase() === '.crx'

  const crx = isCrx ? verifyCrx3(bytes, { requirePublisherProof: false }) : undefined
  const archive = crx?.archive ?? bytes
  const rawManifest = peekManifest(archive)
  // A keyed `.zip` lands in the SAME slot as an already-installed `.zip`/
  // `.crx` whose id (from its own canonicalized manifest key) matches --
  // an update, the same way a `.crx` with the same developer key always
  // has (registry.ts's own doc on `describeUpdater`'s wording for a `.zip`
  // entry). A key-less `.zip`, or one whose key resolves to no existing
  // `file` entry, keeps the previous behaviour: slotted by its own bytes,
  // so two different key-less `.zip`s never collide.
  const slot = crx?.id ?? slotForZipUpdate(ctx.userDataPath, rawManifest) ?? slotHash(bytes)

  return await finishInstall(ctx, {
    rawManifest,
    source: { kind: 'file', fileName: filePath },
    updater: { kind: 'none', reason: 'installed from a local file' },
    slot,
    ...(crx === undefined ? {} : { developerPublicKey: crx.developerPublicKey }),
    write: (targetDir, manifestJson) => {
      unpackZip(archive, targetDir)
      writeManifestOver(targetDir, manifestJson)
    }
  }, where)
}

