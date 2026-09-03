// The real, node:fs-backed LoaderStorage -- storage.ts's own header names
// this as broker-shaped work that lane did not own; this is that work.
//
// TWO ROOTS PER ORIGIN, sibling to nodeFs's own `files/` (node-adapters.ts):
// `code/` holds the pinned asset bytes (confined the same way nodeFs
// confines `fs` capability writes); the pin record is a single file OUTSIDE
// `code/`, never inside it -- ADR-0009's own consequence: the pin record
// must not itself become a hashed leaf.

import { mkdirSync, realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
    }
  }
}
