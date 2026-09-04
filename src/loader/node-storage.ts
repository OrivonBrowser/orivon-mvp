// The real, node:fs-backed LoaderStorage -- storage.ts's own header names
// this as broker-shaped work that lane did not own; this is that work.
//
// TWO ROOTS PER ORIGIN, sibling to nodeFs's own `files/` (node-adapters.ts):
// `code/` holds the pinned asset bytes (confined the same way nodeFs
// confines `fs` capability writes); the pin record is a single file OUTSIDE
// `code/`, never inside it -- ADR-0009's own consequence: the pin record
// must not itself become a hashed leaf.

import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { decodePercentEscapes, foldForIdentity } from '../broker/policy/canonical-path.js'
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
 * Refuses a directory Orivon did not create. `lstatSync`, NEVER `statSync`:
 * statSync follows a symlink and reports the target, so it answers "is there
 * a directory over there", not "is this entry itself a directory".
 *
 * A symlink is refused, never removed: deleting an attacker-controlled path
 * on an attacker-chosen schedule is its own hazard.
 */
function requireRealDirectory (path: string): void {
  const entry = lstatSync(path, { throwIfNoEntry: false })
  if (entry === undefined || entry.isDirectory()) return
  throw new Error(`app storage path exists but is not a directory Orivon created: ${path}`)
}

/**
 * CREATES the root, it does not merely name it -- confinePath's very first
 * act is realpath(root), and a root that has never been created denies
 * every path with 'root-unresolvable' before ever reaching the app's own
 * traversal checks. Mirrors nodeFs.rootFor's exact reasoning
 * (node-adapters.ts) for the identical reason: fs writeAsset's is only
 * reached after this exists.
 *
 * Both directories are checked BEFORE the mkdir, because mkdirSync with
 * `recursive: true` succeeds silently against an existing symlink to a
 * directory -- and confinePath cannot catch that one, since it confines
 * against realpath(root) and would simply confine to the symlink's target.
 * Every writeAsset and every pruneAssets call comes through here, so the
 * check re-runs on each rather than being done once at startup.
 */
function codeRoot (userDataPath: string, origin: string): string {
  const appDirectory = appRoot(userDataPath, origin)
  const root = join(appDirectory, 'code')
  requireRealDirectory(appDirectory)
  requireRealDirectory(root)
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
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    // An unlistable subtree contributes no files rather than aborting the
    // walk. Throwing here would unwind through pruneAssets and abort
    // install() between the last writeAsset and writePin -- leaving a fully
    // written bundle with no pin record, which the next load() reads back as
    // never-pinned fresh TOFU with no reconsent check at all. A subtree left
    // unpruned is disk hygiene; that is not.
    console.error('[loader] pruneAssets: failed to list a directory, skipping that subtree', root, error)
    return out
  }
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) out.push(...await walkFiles(full))
    else if (entry.isFile()) out.push(full)
    // Dirent types come from lstat, so a symlink matches neither branch and
    // is never followed or deleted. Logged rather than passed over silently:
    // nothing here creates one, so its presence is worth knowing about.
    else if (entry.isSymbolicLink()) console.warn('[loader] pruneAssets: ignoring a symlink under the code root', full)
  }
  return out
}

/**
 * Removes `from` and then each of its parents up to (never including) `root`,
 * stopping at the first that is not empty. Called only with a directory this
 * prune just deleted a file from, so a directory a CONCURRENT install has
 * created and not yet written into is never touched -- nothing in the loader
 * removed a directory at all before pruning existed, and a sweep of every
 * empty directory under the root would turn that window into an ENOENT on a
 * write already in flight (docs/open-questions.md A62). The cost is that a
 * directory left empty by some earlier interrupted run is not swept up until
 * a prune deletes from it again.
 *
 * `root` itself always survives: codeRoot() created it and the next
 * writeAsset call for this origin expects it to still be there.
 *
 * ENOENT and ENOTEMPTY are silent: both mean something else changed this
 * directory in between, which is exactly the concurrency this tolerates
 * rather than reports. Anything else is logged and ends the climb.
 */
async function removeEmptyAncestors (root: string, from: string): Promise<void> {
  const prefix = root + sep
  let dir = from
  while (dir !== root && dir.startsWith(prefix)) {
    try {
      if ((await readdir(dir)).length !== 0) return
      await rmdir(dir)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
        console.error('[loader] pruneAssets: failed to remove an empty directory', dir, error)
      }
      return
    }
    dir = dirname(dir)
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
      // foldForIdentity on BOTH sides, so a spelling difference the
      // filesystem does not distinguish cannot read as "delete this". Its
      // case fold is deliberately more permissive than a case-sensitive
      // filesystem is: erring towards "these are the same file" leaves a
      // stale file behind, while erring the other way deletes a live one.
      const keepPaths = new Set(keep.map((canonicalPath) => foldForIdentity(resolveAssetPath(root, canonicalPath))))
      const emptied = new Set<string>()
      for (const filePath of await walkFiles(root)) {
        if (keepPaths.has(foldForIdentity(filePath))) continue
        try {
          // force: true treats an already-gone file (ENOENT) as success --
          // walkFiles and this delete are not atomic (docs/open-questions.md
          // A62), so something else removing the file in between is a race,
          // not an error.
          await rm(filePath, { force: true })
          emptied.add(dirname(filePath))
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
      // Order does not matter: each climb re-reads every directory it visits,
      // so a parent skipped as non-empty is reached again from below once its
      // last subdirectory goes.
      for (const dir of emptied) await removeEmptyAncestors(root, dir)
    }
  }
}
