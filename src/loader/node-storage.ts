// The real, node:fs-backed LoaderStorage -- storage.ts's own header names
// this as broker-shaped work that lane did not own; this is that work.
//
// TWO ROOTS PER ORIGIN, sibling to nodeFs's own `files/` (node-adapters.ts):
// `code/` holds the pinned asset bytes (confined the same way nodeFs
// confines `fs` capability writes); the pin record is a single file OUTSIDE
// `code/`, never inside it -- ADR-0009's own consequence: the pin record
// must not itself become a hashed leaf.

import { mkdirSync, realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { decodePercentEscapes } from '../broker/policy/canonical-path.js'
import { confinePath } from '../broker/policy/paths.js'
import type { PinRecord } from '../broker/policy/pin.js'
import type { LoaderStorage } from './storage.js'
import { appRootDirectoryName } from './storage.js'

function appRoot (userDataPath: string, origin: string): string {
  return join(userDataPath, 'apps', appRootDirectoryName(origin))
}

function pinPath (userDataPath: string, origin: string): string {
  return join(appRoot(userDataPath, origin), 'pin.json')
}

/**
 * CREATES the root, it does not merely name it -- confinePath's very first
 * act is realpath(root), and a root that has never been created denies
 * every path with 'root-unresolvable' before ever reaching the app's own
 * traversal checks. Mirrors nodeFs.rootFor's exact reasoning
 * (node-adapters.ts) for the identical reason: fs writeAsset's is only
 * reached after this exists.
 */
function codeRoot (userDataPath: string, origin: string): string {
  const root = join(appRoot(userDataPath, origin), 'code')
  mkdirSync(root, { recursive: true })
  return root
}

/**
 * Turns a canonical, `/`-rooted, percent-encoded asset path into a real path
 * under `root`. Re-checks confinement even though the caller (fetch-bundle.ts,
 * via bundle-hash.ts's own rejection table) already validated it -- the same
 * defence-in-depth stance every other confined write in this codebase takes,
 * never trusting a guarantee made two call frames away.
 *
 * DECODE FIRST, THEN CONFINE -- ADR-0009's amendment #4 found the opposite
 * order lets `/%00.js` and `/..%2Fevil.js` pass a check on the encoded string
 * while decoding into something dangerous once it becomes a filename.
 */
function resolveAssetPath (root: string, canonicalPath: string): string {
  const decoded = decodePercentEscapes(canonicalPath)
  if (decoded === null) throw new Error(`asset path has a malformed percent-escape: ${canonicalPath}`)
  const relative = decoded.startsWith('/') ? decoded.slice(1) : decoded
  const confined = confinePath(root, relative, realpathSync)
  if (!confined.ok) throw new Error(`asset path rejected by confinement (${confined.reason}): ${canonicalPath}`)
  return confined.resolved
}

/**
 * Every regular file under `root`, as an absolute real path -- a plain
 * manual recursion rather than `readdir`'s own `recursive` option, so this
 * does not depend on a Node version new enough to have it.
 */
async function walkFiles (root: string): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) out.push(...await walkFiles(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/**
 * NFC-folds a resolved path before pruneAssets compares it for equality.
 * HFS+/APFS (a supported run-from-source target, CLAUDE.md Rule 8) store a
 * non-ASCII filename decomposed (NFD) on disk even when the bytes written
 * were precomposed (NFC, the form a JSON manifest string normally carries) --
 * so walkFiles's readdir-derived path and resolveAssetPath's manifest-derived
 * path can name the same file with two different byte sequences. Case is
 * left alone, unlike canonical-path.ts's collisionKey: these are already
 * percent-decoded real filesystem paths, not canonical URL paths, and
 * folding case here would wrongly conflate two distinct files on a
 * case-sensitive filesystem.
 */
function normalizeForComparison (path: string): string {
  return path.normalize('NFC')
}

/**
 * Removes every directory under `root` left empty once pruneAssets has
 * deleted its files -- bottom-up, so a directory that only became empty
 * because its last subdirectory was just removed is caught too. Never
 * removes `root` itself: codeRoot() created it and the next writeAsset call
 * for this origin expects it to still be there. Best-effort, like the
 * deletions above: a directory-listing or rmdir failure is logged and
 * skipped rather than left to abort the prune.
 */
async function removeEmptyDirectories (root: string, dir: string): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    console.error('[loader] pruneAssets: failed to list a directory while removing empty ones', dir, error)
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirectories(root, join(dir, entry.name))
  }
  if (dir === root) return
  try {
    if ((await readdir(dir)).length === 0) await rmdir(dir)
  } catch (error) {
    console.error('[loader] pruneAssets: failed to remove an empty directory', dir, error)
  }
}

export function nodeLoaderStorage (userDataPath: string): LoaderStorage {
  return {
    readPin: async (origin) => {
      let text: string
      try {
        text = await readFile(pinPath(userDataPath, origin), 'utf8')
      } catch (error) {
        // ENOENT alone means "never pinned" -- LoaderStorage.readPin's own
        // doc contract, and the only case index.ts's load() may treat as
        // fresh TOFU. Any OTHER read failure (permissions, a directory where
        // a file was expected, a mid-write crash leaving a 0-byte file some
        // filesystems still let open() succeed on) must NOT collapse into
        // that same undefined -- this origin WAS pinned before, so `{}` is
        // returned instead: not a valid PinRecord shape (parsePinRecord
        // rejects it for lacking `schema`), so it is forced through
        // parsePinRecord's null path and index.ts's own pinnedHash = ''
        // fallback rather than skipping that check entirely.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        return {}
      }
      try {
        return JSON.parse(text) as unknown
      } catch {
        // Corrupt/truncated JSON: same reasoning as the non-ENOENT read
        // failure above -- a file that exists but does not parse is not
        // "never pinned" either.
        return {}
      }
    },
    writePin: async (origin: string, record: PinRecord) => {
      const path = pinPath(userDataPath, origin)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify(record))
    },
    writeAsset: async (origin, path, content) => {
      const resolved = resolveAssetPath(codeRoot(userDataPath, origin), path)
      await mkdir(dirname(resolved), { recursive: true })
      await writeFile(resolved, content)
    },
    pruneAssets: async (origin, keep) => {
      const root = codeRoot(userDataPath, origin)
      const keepPaths = new Set(keep.map((canonicalPath) => normalizeForComparison(resolveAssetPath(root, canonicalPath))))
      for (const filePath of await walkFiles(root)) {
        if (keepPaths.has(normalizeForComparison(filePath))) continue
        try {
          // force: true treats an already-gone file (ENOENT) as success --
          // walkFiles and this delete are not atomic (docs/open-questions.md
          // A62), so something else removing the file in between is a race,
          // not an error.
          await rm(filePath, { force: true })
        } catch (error) {
          // A genuine failure here (EPERM, a directory where a file was
          // expected) is disk hygiene, not a security gap: install() (this
          // file's own header) still calls writePin right after pruneAssets
          // returns, and letting one stray file abort that would leave a
          // fully-written bundle with no pin record at all -- worse than the
          // file this leaves behind.
          console.error('[loader] pruneAssets: failed to delete a superseded asset', filePath, error)
        }
      }
      await removeEmptyDirectories(root, root)
    }
  }
}
