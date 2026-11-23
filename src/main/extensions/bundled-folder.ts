// An extension that ships with Orivon is unpacked once, when Orivon is built, into a folder beside its `.crx`; the
// installed package carries that folder and the application loads the extension from it, where it is, so the first
// start writes no file of it. Durable: node:fs and node:crypto, no Electron; the build script and the application both
// import it.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { loadableManifest, readExtensionManifest } from '../../broker/policy/extension-manifest.js'
import { verifyCrx3 } from './crx.js'
import { manifestText } from './effective-manifest.js'
import { peekManifest, unpackZip, writeManifestOver } from './unpack-runner.js'

/** What the build leaves beside a bundled extension's folder, next to its `.crx` in `extensions/`. */
export interface BundledRecord {
  /** The pinned digest of the `.crx` the folder was unpacked from: a folder is current while this matches the list's. */
  readonly sha256: string
  /** The manifest the `.crx` held, with its developer key as `key`: the input of an install, so the extension keeps the id its release key gives. */
  readonly manifest: Record<string, unknown>
}

export function bundledRecordFile (folder: string): string {
  return `${folder}.bundled.json`
}

/** The record of the extension unpacked into `folder` of `extensionsDir`, or undefined when there is none or it is not this file's shape. */
export function readBundledRecord (extensionsDir: string, folder: string): BundledRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(extensionsDir, bundledRecordFile(folder)), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { sha256, manifest } = parsed as { sha256?: unknown, manifest?: unknown }
    if (typeof sha256 !== 'string' || typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return undefined
    return { sha256, manifest: manifest as Record<string, unknown> }
  } catch {
    return undefined
  }
}

/** The text of the `manifest.json` the folder holds: the manifest an install would load, as `finishInstall` writes it. */
export function bundledManifestText (record: BundledRecord): string | undefined {
  const parsed = readExtensionManifest(record.manifest)
  return parsed.ok ? manifestText(loadableManifest(record.manifest).manifest) : undefined
}

/**
 * Unpacks the `.crx` named `file` of `extensionsDir` into `folder` unless the folder already comes from the digest
 * `sha256`: verifies the signature the way an install does, keeps the manifest an install would load (its blocked
 * permissions removed, its developer key set) and writes the record. Throws when the file is not a signed extension.
 * Returns whether it unpacked.
 */
export function prepareBundledFolder (extensionsDir: string, file: string, folder: string, sha256: string): boolean {
  const target = join(extensionsDir, folder)
  if (readBundledRecord(extensionsDir, folder)?.sha256 === sha256 && existsSync(join(target, 'manifest.json'))) return false

  const crx = verifyCrx3(Buffer.from(readFileSync(join(extensionsDir, file))), { requirePublisherProof: false })
  const manifest = { ...peekManifest(crx.archive), key: crx.developerPublicKey.toString('base64') }
  const parsed = readExtensionManifest(manifest)
  if (!parsed.ok) throw new Error(`${file}: manifest refused: ${parsed.reason}`)

  const next = `${target}.next-${randomBytes(4).toString('hex')}`
  try {
    unpackZip(crx.archive, next)
    writeManifestOver(next, manifestText(loadableManifest(manifest).manifest))
    rmSync(target, { recursive: true, force: true })
    renameSync(next, target)
  } catch (error) {
    rmSync(next, { recursive: true, force: true })
    throw error
  }
  mkdirSync(extensionsDir, { recursive: true })
  writeFileSync(join(extensionsDir, bundledRecordFile(folder)), JSON.stringify({ sha256, manifest }))
  return true
}
