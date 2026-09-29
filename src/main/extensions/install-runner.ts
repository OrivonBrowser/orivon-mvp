// Installs an extension from an unpacked folder, a `.crx` file or a `.zip`
// file: reads its manifest, shows the install prompt, writes the loaded
// copy, loads it into the session, and records it in the registry. I/O
// (`-runner.ts`, src/main/README.md's suffix rule) -- the prompt itself is
// injected (`InstallPrompt`), so this file is testable with a fake one,
// matching `src/main/install/app-install.ts`'s own split from its real
// dialog.

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, sep } from 'node:path'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import type { Session } from 'electron'
import AdmZip from 'adm-zip'
import {
  describeExtensionInstall, loadableManifest, readExtensionManifest, updateRequiresConsent,
  type ExtensionInstallDescription, type ExtensionInstallSource, type ExtensionManifestFacts
} from '../../broker/policy/extension-manifest.js'
import { isString, ownProperty } from '../../broker/policy/own-property.js'
import { verifyCrx3 } from './crx.js'
import { unpackZip } from './unpack-runner.js'
import { patchStoreUpdater, readRegistry, writeRegistry } from './registry-runner.js'
import type { ExtensionSource, ExtensionUpdater, InstalledExtension } from './registry.js'
import { generateId } from '../../../vendor/electron-chrome-web-store/src/browser/id.js'
import { downloadCrxBytes } from '../../../vendor/electron-chrome-web-store/src/browser/installer.js'
import { storeCrxDownloadUrl, storeTestPublisherKeyHash } from './store-download-seam.js'

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

function readManifestObject (raw: unknown, context: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${context}: manifest.json is not an object`)
  }
  return raw as Record<string, unknown>
}

/** Writes `sourceDir`'s contents to `targetDir`, tmp-directory-then-rename
 * like `unpackZip` (../extensions/unpack-runner.ts's own doc): a copy that
 * dies partway must never leave `targetDir` half-written for the next boot
 * to load. `manifestJson` replaces whatever `manifest.json` the source
 * folder had. */
function writeFolderCopy (sourceDir: string, targetDir: string, manifestJson: string): void {
  mkdirSync(dirname(targetDir), { recursive: true })
  const tmpDir = `${targetDir}.tmp-${randomBytes(6).toString('hex')}`
  try {
    cpSync(sourceDir, tmpDir, { recursive: true })
    writeManifestOver(tmpDir, manifestJson)
    renameSync(tmpDir, targetDir)
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true })
    throw error
  }
}

function writeManifestOver (dir: string, manifestJson: string): void {
  writeFileSync(join(dir, 'manifest.json'), manifestJson)
}

function slotKeyPath (userDataPath: string, slot: string): string {
  return join(extensionsRoot(userDataPath), slot, 'key.pub')
}

/**
 * The per-slot RSA public key (SPKI DER, base64) that keeps a folder or
 * `.zip` install's extension id stable across every update into `slot` --
 * `resolveInstallKey`'s own doc says where this ranks against a manifest's
 * own `key` and a `.crx`'s developer key. Generated once and persisted at
 * `slotKeyPath`, then reused for every later install into the same slot;
 * the matching private key is never exported, since nothing here signs
 * with it.
 */
export function resolveSlotKey (userDataPath: string, slot: string): string {
  const keyPath = slotKeyPath(userDataPath, slot)
  try {
    return readFileSync(keyPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const encoded = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  mkdirSync(dirname(keyPath), { recursive: true })
  writeFileSync(keyPath, encoded)
  return encoded
}

/**
 * The `key` (SPKI DER, base64) every loaded copy in `pending.slot` carries,
 * so Electron derives a stable id across an update instead of one that
 * embeds the version-numbered load path (README.md's Design notes, "Why
 * every installed copy's manifest carries a key"). A `.crx`'s verified
 * developer key (crx.ts's own doc) wins outright when there is one -- Chrome
 * itself ignores a packed CRX's manifest `key`, so a `.crx` whose manifest
 * claims a different `key` never gets to borrow another extension's id
 * this way. Only a folder or `.zip` install, which carries no signature at
 * all, falls back to the manifest's own `key` (Chrome keeps it there), else
 * the slot's generated key.
 */
function resolveInstallKey (ctx: InstallContext, pending: PendingInstall, manifestKey: string | undefined): string {
  if (pending.developerPublicKey !== undefined) return pending.developerPublicKey.toString('base64')
  if (manifestKey !== undefined) return manifestKey
  return resolveSlotKey(ctx.userDataPath, pending.slot)
}

/** `manifest.json`'s bytes read straight out of a zip archive, without
 * extracting anything else to disk -- `installFromFile`'s `.crx`/`.zip`
 * paths both need to read the manifest BEFORE they know the final
 * `<slot>/<version>/` target directory `unpackZip` writes to. */
function peekManifest (archive: Buffer): Record<string, unknown> {
  const zip = new AdmZip(archive)
  const entry = zip.getEntry('manifest.json')
  if (entry === null) throw new Error('archive has no manifest.json')
  const parsed: unknown = JSON.parse(entry.getData().toString('utf8'))
  return readManifestObject(parsed, 'archive')
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
  const key = resolveInstallKey(ctx, pending, manifestKey)
  manifest.key = key
  const id = generateId(key)

  // Matched by SLOT, the directory the versions of one install live under
  // (README.md's Design notes); the key resolved above makes `id` stable
  // per slot as well.
  const slotDir = join(extensionsRoot(ctx.userDataPath), pending.slot)
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
   * again, so a failed reinstall never leaves the slot with neither copy. */
  async function restoreAsideOnFailure (): Promise<void> {
    if (asideDir === undefined) {
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

  let loaded: Awaited<ReturnType<Session['extensions']['loadExtension']>>
  try {
    loaded = await ctx.session.extensions.loadExtension(targetDir, { allowFileAccess: false })
  } catch (error) {
    await restoreAsideOnFailure()
    throw error
  }

  const now = Date.now()
  const entry: InstalledExtension = {
    id: loaded.id,
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

  const kept = registry.filter((existing) => !previousInSlot.includes(existing))
  writeRegistry(ctx.userDataPath, [...kept, entry])

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
  const slot = crx?.id ?? slotHash(bytes)
  const rawManifest = peekManifest(archive)

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
      patchStoreUpdater(ctx.userDataPath, expectedId, {
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

export async function uninstall (ctx: InstallContext, id: string): Promise<void> {
  const registry = readRegistry(ctx.userDataPath)
  const entry = registry.find((candidate) => candidate.id === id)
  if (entry === undefined) return
  ctx.session.extensions.removeExtension(id)
  rmSync(entry.path, { recursive: true, force: true })
  writeRegistry(ctx.userDataPath, registry.filter((candidate) => candidate.id !== id))
}

/**
 * Electron has no "disable" for a loaded extension, only load/unload
 * (../README.md's Design notes): disabling removes it from the session and
 * flips `enabled: false` in the registry, so extensions-subsystem.ts simply
 * skips it on the next boot; enabling loads it again right away.
 */
export async function setEnabled (ctx: InstallContext, id: string, enabled: boolean): Promise<void> {
  const registry = readRegistry(ctx.userDataPath)
  const entry = registry.find((candidate) => candidate.id === id)
  if (entry === undefined || entry.enabled === enabled) return
  if (enabled) {
    await ctx.session.extensions.loadExtension(entry.path, { allowFileAccess: false })
  } else {
    ctx.session.extensions.removeExtension(id)
  }
  writeRegistry(ctx.userDataPath, registry.map((candidate) => candidate.id === id ? { ...candidate, enabled } : candidate))
}
