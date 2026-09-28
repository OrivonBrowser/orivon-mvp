// Installs an extension from an unpacked folder, a `.crx` file or a `.zip`
// file: reads its manifest, shows the install prompt, writes the loaded
// copy, loads it into the session, and records it in the registry. I/O
// (`-runner.ts`, src/main/README.md's suffix rule) -- the prompt itself is
// injected (`InstallPrompt`), so this file is testable with a fake one,
// matching `src/main/install/app-install.ts`'s own split from its real
// dialog.

import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, sep } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type { Session } from 'electron'
import AdmZip from 'adm-zip'
import {
  describeExtensionInstall, loadableManifest, readExtensionManifest,
  type ExtensionInstallDescription, type ExtensionInstallSource
} from '../../broker/policy/extension-manifest.js'
import { verifyCrx3 } from './crx.js'
import { unpackZip } from './unpack-runner.js'
import { readRegistry, writeRegistry } from './registry-runner.js'
import type { ExtensionSource, ExtensionUpdater, InstalledExtension } from './registry.js'

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
  /** Writes the loaded copy at `targetDir`, with `manifestJson` in place of
   * `manifest.json` -- everything install-runner.ts's caller-specific step
   * (folder copy, or the already-downloaded archive) needed to know. */
  readonly write: (targetDir: string, manifestJson: string) => void
}

async function finishInstall (ctx: InstallContext, pending: PendingInstall): Promise<InstallOutcome> {
  const manifestResult = readExtensionManifest(pending.rawManifest)
  if (!manifestResult.ok) return { installed: false, reason: `manifest refused: ${manifestResult.reason}` }
  const { facts } = manifestResult

  const description = describeExtensionInstall(facts, pending.source.kind as ExtensionInstallSource)
  const allowed = await ctx.prompt(description)
  if (!allowed) return { installed: false, reason: 'declined by the person' }

  const { manifest, stripped } = loadableManifest(pending.rawManifest)
  const targetDir = join(extensionsRoot(ctx.userDataPath), pending.slot, facts.version)
  pending.write(targetDir, JSON.stringify(manifest))

  const loaded = await ctx.session.extensions.loadExtension(targetDir, { allowFileAccess: false })

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

  // Matched by SLOT, never by `entry.id` alone: Electron derives an
  // unpacked extension's id from its own load path when the manifest
  // carries no `key` (Chromium's own id_util::GenerateIdForPath), and that
  // path's version segment changes on every update -- an id match would
  // never find "the same extension, an older version" for a folder or
  // `.zip` install. A `.crx` install's `key` (installFromFile's own doc)
  // keeps ITS id stable across versions too, so this still finds it.
  const slotDir = join(extensionsRoot(ctx.userDataPath), pending.slot)
  const registry = readRegistry(ctx.userDataPath)
  const previousInSlot = registry.filter((existing) => existing.path.startsWith(`${slotDir}${sep}`))
  const kept = registry.filter((existing) => !previousInSlot.includes(existing))
  writeRegistry(ctx.userDataPath, [...kept, entry])

  // Only after the new version has actually loaded (README.md's Design
  // notes): a load failure above already threw, leaving every OLD folder
  // and registry entry untouched.
  for (const previous of previousInSlot) {
    if (previous.path !== entry.path) rmSync(previous.path, { recursive: true, force: true })
  }

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
  const developerPublicKey = crx?.developerPublicKey
  const rawManifest = peekManifest(archive)

  return await finishInstall(ctx, {
    rawManifest,
    source: { kind: 'file', fileName: filePath },
    updater: { kind: 'none', reason: 'installed from a local file' },
    slot,
    write: (targetDir, manifestJson) => {
      unpackZip(archive, targetDir)
      const written = developerPublicKey === undefined
        ? manifestJson
        : JSON.stringify({ ...(JSON.parse(manifestJson) as Record<string, unknown>), key: developerPublicKey.toString('base64') })
      writeManifestOver(targetDir, written)
    }
  })
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
