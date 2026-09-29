// Materializes an extension's loaded copy on disk, from a `.zip`/unpacked-
// `.crx` archive OR an unpacked folder, under `<userData>/extensions/` --
// I/O (`-runner.ts`, src/main/README.md's suffix rule), called by
// install-runner.ts. checkZipEntryPath below is the pure half: every path
// decision an untrusted zip entry can influence, factored out so it is
// unit-testable without touching a real filesystem.

import AdmZip from 'adm-zip'
import { cpSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep as pathSep } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Generous for any real extension, bounded so a zip bomb's entry count or
 * uncompressed size is refused before a single byte of it is written. */
export const MAX_UNPACK_ENTRIES = 10_000
export const MAX_UNPACK_BYTES = 256 * 1024 * 1024

const S_IFMT = 0xF000
const S_IFLNK = 0xA000

export type ZipEntryCheck =
  | { readonly ok: true }
  | { readonly ok: false, readonly reason: string }

/**
 * Pure. Is `entryName` safe to write under `targetDir`? Refuses an absolute
 * path (POSIX or a Windows drive letter -- this codebase runs on both), a
 * `..` path segment, an entry a manifest never has: a bare CVE-2018-1002204-
 * class zip-slip, though `adm-zip` 0.6.1 already carries its own fix
 * (`node_modules/adm-zip/util/utils.js`'s own header). This is Orivon's own
 * layer on top, in the shape `docs/development/code-guidelines.md` wants
 * for every path decision: inspectable and independently testable, not
 * trusted to a dependency alone. `unixMode` is the entry's Unix file mode
 * (`zipEntry.header.attr >>> 16` -- adm-zip stores the external file
 * attributes in the high 16 bits for a Unix-made archive); a symlink entry
 * is refused outright, since Orivon never wants one inside an extension's
 * loaded folder.
 */
export function checkZipEntryPath (targetDir: string, entryName: string, unixMode: number): ZipEntryCheck {
  if ((unixMode & S_IFMT) === S_IFLNK) return { ok: false, reason: `${entryName}: symlink entries are refused` }
  if (entryName.length === 0) return { ok: false, reason: 'empty entry name' }
  if (entryName.startsWith('/') || /^[a-zA-Z]:/.test(entryName)) {
    return { ok: false, reason: `${entryName}: absolute path` }
  }
  // A zip entry name is always forward-slash separated (APPNOTE.TXT
  // 4.4.17.1), regardless of the platform that reads it -- split on '/'
  // explicitly rather than node:path's platform-dependent segmenter.
  if (entryName.split('/').includes('..')) return { ok: false, reason: `${entryName}: ".." path segment` }

  const resolvedTarget = resolve(targetDir)
  const resolvedEntry = resolve(resolvedTarget, entryName)
  if (resolvedEntry !== resolvedTarget && !resolvedEntry.startsWith(resolvedTarget + pathSep)) {
    return { ok: false, reason: `${entryName}: resolves outside the target directory` }
  }
  return { ok: true }
}

export interface UnpackedZip {
  readonly path: string
}

/**
 * Extracts `zipBytes` into `targetDir`, which must not already exist.
 * Every entry is checked with checkZipEntryPath before anything is written
 * -- refusing entry 9,000 after entries 1-8,999 already landed on disk
 * would leave a half-written folder behind, so the whole archive is
 * validated first, then written to `<targetDir>.tmp-<random>` and renamed
 * into place, the same write-then-rename shape
 * `src/broker/grants/node-ledger-storage.ts`'s `writeFileAtomic` uses for
 * the identical reason: a reader (the extensions subsystem, on the next
 * boot) must only ever see the old state or the new one, never a partial
 * write caught mid-extraction by a crash.
 */
export function unpackZip (zipBytes: Buffer, targetDir: string): UnpackedZip {
  const zip = new AdmZip(zipBytes)
  const entries = zip.getEntries()
  if (entries.length > MAX_UNPACK_ENTRIES) {
    throw new Error(`archive has ${String(entries.length)} entries, over the ${String(MAX_UNPACK_ENTRIES)} cap`)
  }
  let totalBytes = 0
  for (const entry of entries) {
    totalBytes += entry.header.size
    if (totalBytes > MAX_UNPACK_BYTES) {
      throw new Error(`archive's uncompressed size exceeds the ${String(MAX_UNPACK_BYTES)}-byte cap`)
    }
    const unixMode = entry.header.attr >>> 16
    const check = checkZipEntryPath(targetDir, entry.entryName, unixMode)
    if (!check.ok) throw new Error(`refused zip entry: ${check.reason}`)
  }

  mkdirSync(dirname(targetDir), { recursive: true })
  const tmpDir = `${targetDir}.tmp-${randomBytes(6).toString('hex')}`
  mkdirSync(tmpDir, { recursive: true })
  try {
    // Re-validated by adm-zip's own extraction too (util/utils.js's
    // sanitize/assertPathSafe) -- belt and suspenders, not redundant: that
    // check runs against the real filesystem (an existing symlink at the
    // target) and this one runs against the archive's own declared shape.
    zip.extractAllTo(tmpDir, true)
    renameSync(tmpDir, targetDir)
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true })
    throw error
  }
  return { path: targetDir }
}

/** True when `raw` is a plain object, never an array or `null` --
 * `manifest.json`'s own top-level shape, whichever way it was read
 * (straight off disk, or out of an archive's own bytes below). */
export function readManifestObject (raw: unknown, context: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${context}: manifest.json is not an object`)
  }
  return raw as Record<string, unknown>
}

/** `manifest.json`'s bytes read straight out of a zip archive, without
 * extracting anything else to disk -- install-runner.ts's `.crx`/`.zip`
 * paths both need to read the manifest BEFORE they know the final
 * `<slot>/<version>/` target directory `unpackZip` writes to. */
export function peekManifest (archive: Buffer): Record<string, unknown> {
  const zip = new AdmZip(archive)
  const entry = zip.getEntry('manifest.json')
  if (entry === null) throw new Error('archive has no manifest.json')
  const parsed: unknown = JSON.parse(entry.getData().toString('utf8'))
  return readManifestObject(parsed, 'archive')
}

export function writeManifestOver (dir: string, manifestJson: string): void {
  writeFileSync(join(dir, 'manifest.json'), manifestJson)
}

/**
 * Refuses `dir` (recursively) if any entry is a symlink, or is neither a
 * regular file nor a directory -- `cpSync`'s own `recursive` copy follows a
 * symlink wherever it points, including outside `dir` entirely, and
 * Electron's `loadExtension` follows one just as happily once the copy
 * lands under `chrome-extension://<id>/`; unlike this file's own
 * `checkZipEntryPath`, which only ever sees the archive's own declared
 * entries, this walks the real filesystem, so a symlink planted by
 * something else that ran before this install started is refused too.
 * Every entry is checked before anything is copied, matching
 * `checkZipEntryPath`'s own error shape.
 */
function assertNoSymlinks (dir: string): void {
  for (const name of readdirSync(dir)) {
    const entryPath = join(dir, name)
    const stat = lstatSync(entryPath)
    if (stat.isSymbolicLink()) throw new Error(`refused unpacked entry: ${entryPath}: symlink entries are refused`)
    if (stat.isDirectory()) {
      assertNoSymlinks(entryPath)
    } else if (!stat.isFile()) {
      throw new Error(`refused unpacked entry: ${entryPath}: not a regular file or directory`)
    }
  }
}

/** Writes `sourceDir`'s contents to `targetDir`, tmp-directory-then-rename
 * like `unpackZip` above: a copy that dies partway must never leave
 * `targetDir` half-written for the next boot to load. `manifestJson`
 * replaces whatever `manifest.json` the source folder had.
 * `assertNoSymlinks` runs before any byte is copied, the same validate-
 * everything-first-then-write order `unpackZip` uses. */
export function writeFolderCopy (sourceDir: string, targetDir: string, manifestJson: string): void {
  assertNoSymlinks(sourceDir)
  mkdirSync(dirname(targetDir), { recursive: true })
  const tmpDir = `${targetDir}.tmp-${randomBytes(6).toString('hex')}`
  try {
    cpSync(sourceDir, tmpDir, { recursive: true })
    assertNoSymlinks(tmpDir) // the source can change between the check above and the copy
    writeManifestOver(tmpDir, manifestJson)
    renameSync(tmpDir, targetDir)
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true })
    throw error
  }
}
