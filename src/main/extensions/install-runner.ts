// Installs an extension from an unpacked folder, a `.crx` file or a `.zip`
// file: reads its manifest, shows the install prompt, writes the loaded
// copy, loads it into the session, and records it in the registry. I/O
// (`-runner.ts`, src/main/README.md's suffix rule) -- the prompt itself is
// injected (`InstallPrompt`), so this file is testable with a fake one,
// matching `src/main/install/app-install.ts`'s own split from its real
// dialog.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type { Session } from 'electron'
import {
  describeExtensionInstall, loadableManifest, readExtensionManifest, updateRequiresConsent,
  type ExtensionInstallDescription, type ExtensionInstallSource, type ExtensionManifestFacts
} from '../../broker/policy/extension-manifest.js'
import { isString, ownProperty } from '../../broker/policy/own-property.js'
import { verifyCrx3 } from './crx.js'
import { peekManifest, readManifestObject, unpackZip, writeFolderCopy, writeManifestOver } from './unpack-runner.js'
import {
  canonicalizeManifestKey, patchStoreUpdater, readRegistry, resolveInstallKey, slotOfFileEntry, withRegistryLock,
  writeRegistry
} from './registry-runner.js'
import type { ExtensionSource, ExtensionUpdater, InstalledExtension } from './registry.js'
import { clearPersistedRuleState } from './dnr/dnr-runner.js'
import { clearPendingDnrInstall, registerPendingDnrInstall } from './extensions-dnr.js'
import { generateId } from '../../../vendor/electron-chrome-web-store/src/browser/id.js'
import { downloadCrxBytes } from '../../../vendor/electron-chrome-web-store/src/browser/installer.js'
import { storeCrxDownloadUrl, storeTestPublisherKeyHash } from './store-download-seam.js'

// resolveSlotKey moved to registry-runner.ts (key.pub is persisted
// bookkeeping under <userData>/extensions/, the same concern registry.json
// itself is) -- re-exported here since e2e fixtures and test/
// extensions-fixtures.ts import it from this file's own public surface.
export { resolveSlotKey } from './registry-runner.js'

export type InstallPrompt = (description: ExtensionInstallDescription) => Promise<boolean>

export interface InstallContext {
  readonly userDataPath: string
  readonly session: Session
  readonly prompt: InstallPrompt
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

interface PendingInstall {
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

async function finishInstall (ctx: InstallContext, pending: PendingInstall): Promise<InstallOutcome> {
  const manifestResult = readExtensionManifest(pending.rawManifest)
  if (!manifestResult.ok) return { installed: false, reason: `manifest refused: ${manifestResult.reason}` }
  const { facts } = manifestResult

  const description = describeExtensionInstall(facts, pending.source.kind as ExtensionInstallSource)
  const allowed = pending.preApproved === true || await ctx.prompt(description)
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
    pending.write(targetDir, JSON.stringify(manifest))
  } catch (error) {
    await restoreAsideOnFailure()
    throw error
  }

  const now = Date.now()
  const entry: InstalledExtension = {
    id,
    name: facts.name,
    version: facts.version,
    enabled: true,
    installedAt: now,
    updatedAt: now,
    source: pending.source,
    updater: pending.updater,
    path: targetDir,
    stripped
  }

  // Handed to the declarativeNetRequest service BEFORE loadExtension: the
  // registry write below only lands after the load resolves, so its own
  // 'extension-loaded' listener would otherwise find no entry (a fresh
  // install) or the previous one (an update). extensions-dnr.ts has the
  // full account.
  registerPendingDnrInstall(entry)

  let loaded: Awaited<ReturnType<Session['extensions']['loadExtension']>>
  try {
    loaded = await ctx.session.extensions.loadExtension(targetDir, { allowFileAccess: false })
  } catch (error) {
    // Left in place, the pending entry would be taken for the previous
    // version that restoreAsideOnFailure may reload under this same id.
    clearPendingDnrInstall(id)
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
export async function installFromFolder (ctx: InstallContext, dir: string): Promise<InstallOutcome> {
  const rawManifest = readManifestObject(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')), dir)
  return await finishInstall(ctx, {
    rawManifest,
    source: { kind: 'unpacked', from: dir },
    updater: { kind: 'none', reason: 'unpacked extensions have no update mechanism' },
    slot: slotHash(Buffer.from(dir)),
    write: (targetDir, manifestJson) => { writeFolderCopy(dir, targetDir, manifestJson) }
  })
}

/**
 * Installs from a `.crx` or `.zip` file the person picked. A `.crx` is
 * verified with `requirePublisherProof: false` -- a local file need not
 * have come from the Chrome Web Store, so only the developer proof
 * (crx.ts's own doc) is required. A `.zip` carries no signature at all: its
 * slot is derived from the file's own bytes, never from a claimed identity.
 */
export async function installFromFile (ctx: InstallContext, filePath: string): Promise<InstallOutcome> {
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
  })
}

/** The lines `describeExtensionInstall(next, 'store').detail` has that
 * `describeExtensionInstall(previous, 'store').detail` does not -- reuses
 * the install prompt's own wording rather than inventing a second way to
 * describe a permission, so a held-back update's registered reason and a
 * store install's prompt never disagree about what a given permission
 * means. */
function describeWhatIsNew (previous: ExtensionManifestFacts, next: ExtensionManifestFacts): string {
  const before = new Set(describeExtensionInstall(previous, 'store').detail.split('\n'))
  const added = describeExtensionInstall(next, 'store').detail.split('\n').filter((line) => line !== '' && !before.has(line))
  return added.length > 0 ? added.join('; ') : 'more access'
}

export interface InstallFromStoreOptions {
  /** Skip this function's own install prompt -- see PendingInstall's own doc
   * on `preApproved` for who may set this and why. */
  readonly skipPrompt?: boolean
  /** The CRX's own download URL, recorded as `updater.pendingUpdate` when
   * this call holds an update back for consent, so `updateFromStore` can
   * re-fetch the exact bytes without another Omaha check. */
  readonly downloadUrl?: string
  /** Test-only seam, threaded straight to crx.ts's `verifyCrx3` -- see its
   * own doc. Falls back to store-download-seam.ts's env-driven override
   * (e2e builds only), then to crx.ts's real Chrome Web Store key hash. */
  readonly publisherKeyHash?: Buffer
}

/**
 * Installs or updates a Chrome Web Store extension from already-downloaded
 * CRX bytes: `verifyCrx3` with `requirePublisherProof: true` (every store CRX
 * needs both the developer's proof and the store's own), refuses when the
 * CRX's own id differs from `expectedId`,
 * and -- when `approvedManifest` names what is currently installed -- holds
 * the update back instead of installing it if it asks for more than that
 * (T19's subset rule, `updateRequiresConsent`): nothing is written, and the
 * registry's `updater.lastResult` records why, in the person's own words,
 * so the extensions page can show it without a further check.
 *
 * `approvedManifest` is what tells this function whether it is being asked
 * for a FRESH install (undefined: nothing to compare against, so nothing
 * can need consent) or an UPDATE (the currently loaded manifest): a fresh
 * store install is always `options.skipPrompt: true` (the store page's own
 * `beforeInstall` hook already showed the prompt, from the same manifest,
 * before download -- showing this function's own prompt too would be a
 * second dialog for one decision) and a silent background update is too
 * (skipPrompt, AND held back rather than prompted, if it widens anything);
 * the "Update" button (`updateFromStore` below) is the one caller that
 * wants this function's own prompt: it passes no `approvedManifest` at all,
 * so nothing is held back, and no `skipPrompt`, so the ordinary store
 * install prompt -- built from the update's own, current permissions --
 * shows before it lands.
 */
export async function installFromStoreCrx (
  ctx: InstallContext,
  crxBytes: Buffer,
  expectedId: string,
  approvedManifest?: string,
  options: InstallFromStoreOptions = {}
): Promise<InstallOutcome> {
  const publisherKeyHash = options.publisherKeyHash ?? storeTestPublisherKeyHash()
  const crx = verifyCrx3(crxBytes, { requirePublisherProof: true, ...(publisherKeyHash === undefined ? {} : { publisherKeyHash }) })
  if (crx.id !== expectedId) {
    throw new Error(`downloaded CRX id ${crx.id} does not match the requested extension ${expectedId}`)
  }
  const rawManifest = peekManifest(crx.archive)

  // No prompt here means the person approved a manifest elsewhere (the store page, or the
  // version already installed); without it, or with one that does not parse, refuse.
  if (options.skipPrompt === true && approvedManifest === undefined) {
    return { installed: false, reason: 'a store install arrived without the manifest the person approved' }
  }
  if (approvedManifest !== undefined) {
    const approved = readExtensionManifest(JSON.parse(approvedManifest))
    const next = readExtensionManifest(rawManifest)
    if (!approved.ok || !next.ok) return { installed: false, reason: 'the approved or downloaded manifest could not be read' }
    if (updateRequiresConsent(approved.facts, next.facts)) {
      const reason = `needs your approval: ${describeWhatIsNew(approved.facts, next.facts)}`
      await patchStoreUpdater(ctx.userDataPath, expectedId, {
        lastCheckedAt: Date.now(),
        lastResult: reason,
        ...(options.downloadUrl === undefined ? {} : { pendingUpdate: { url: options.downloadUrl, version: next.facts.version } })
      })
      return { installed: false, reason }
    }
  }

  return await finishInstall(ctx, {
    rawManifest,
    source: { kind: 'store', storeId: expectedId },
    updater: { kind: 'store', lastCheckedAt: Date.now(), lastResult: approvedManifest === undefined ? 'installed' : 'updated' },
    slot: expectedId,
    developerPublicKey: crx.developerPublicKey,
    preApproved: options.skipPrompt === true,
    write: (targetDir, manifestJson) => { unpackZip(crx.archive, targetDir); writeManifestOver(targetDir, manifestJson) }
  })
}

/**
 * The e2e-only entry point `test/e2e-extensions-store.test.ts` drives
 * (through `store-test-hook.ts`'s dev-only `globalThis` hook -- no
 * `chrome.webstorePrivate` page exists in that suite to trigger the real
 * flow from) and the seam that lets it point at a fixture server instead of
 * the real store: `storeCrxDownloadUrl` returns the real store's URL unless
 * store-download-seam.ts's env-driven override is compiled in and set.
 */
export async function installFromStore (ctx: InstallContext, expectedId: string): Promise<InstallOutcome> {
  const { bytes } = await downloadCrxBytes(storeCrxDownloadUrl(expectedId))
  return await installFromStoreCrx(ctx, bytes, expectedId)
}

/**
 * The "Update" button's own action: re-downloads exactly the update a held-
 * back check found (`entry.updater.pendingUpdate`, set by
 * `installFromStoreCrx` above) and installs it with no `approvedManifest`,
 * so nothing is held back a second time -- the person clicking this button
 * IS the consent -- and no `skipPrompt`, so the ordinary store install
 * prompt still shows, built from the update's own permissions, before it
 * lands.
 */
export async function updateFromStore (ctx: InstallContext, id: string): Promise<InstallOutcome> {
  const entry = readRegistry(ctx.userDataPath).find((candidate) => candidate.id === id)
  const pending = entry?.updater.kind === 'store' ? entry.updater.pendingUpdate : undefined
  if (pending === undefined) return { installed: false, reason: 'no update is pending' }
  const { bytes } = await downloadCrxBytes(pending.url)
  return await installFromStoreCrx(ctx, bytes, id)
}

/** Runs entirely under `withRegistryLock` (registry-runner.ts's own doc):
 * an install landing on the same `userDataPath` while this is in flight
 * reads a registry that already reflects this removal, or this reads one
 * that already reflects that install -- never a copy read before the
 * other's own write. */
export async function uninstall (ctx: InstallContext, id: string): Promise<void> {
  await withRegistryLock(ctx.userDataPath, (registry) => {
    const entry = registry.find((candidate) => candidate.id === id)
    if (entry === undefined) return
    ctx.session.extensions.removeExtension(id)
    rmSync(entry.path, { recursive: true, force: true })
    // Chrome clears an uninstalled extension's dynamic rules and enabled-
    // ruleset choice too. The slot's key.pub stays: a reinstall into the
    // same slot must resolve to the same id.
    clearPersistedRuleState(dirname(entry.path))
    writeRegistry(ctx.userDataPath, registry.filter((candidate) => candidate.id !== id))
  })
}

/**
 * Electron has no "disable" for a loaded extension, only load/unload
 * (../README.md's Design notes): disabling removes it from the session and
 * flips `enabled: false` in the registry, so extensions-subsystem.ts simply
 * skips it on the next boot; enabling loads it again right away. Runs
 * entirely under `withRegistryLock`, the same reason `uninstall` above does.
 */
export async function setEnabled (ctx: InstallContext, id: string, enabled: boolean): Promise<void> {
  await withRegistryLock(ctx.userDataPath, async (registry) => {
    const entry = registry.find((candidate) => candidate.id === id)
    if (entry === undefined || entry.enabled === enabled) return
    if (enabled) {
      await ctx.session.extensions.loadExtension(entry.path, { allowFileAccess: false })
    } else {
      ctx.session.extensions.removeExtension(id)
    }
    writeRegistry(ctx.userDataPath, registry.map((candidate) => candidate.id === id ? { ...candidate, enabled } : candidate))
  })
}
