// Finds the profiles of the installed browsers that have something to bring in. A profile's directory comes
// from a file the other browser wrote, so it is followed only when it resolves inside that browser's own
// root: a crafted `Local State` or `profiles.ini` cannot point the reader anywhere else.
import { join, sep } from 'node:path'
import { parseProfilesIni } from './firefox-places.js'
import type { ImportFs } from './import-fs.js'
import { MAX_IMPORT_BYTES } from './import-types.js'
import type { BrowserRoot, ImportSource } from './import-types.js'

const CHROMIUM_PROFILE_DIR = /^(Default|Profile \d{1,4})$/

const isInside = (root: string, path: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

/** A directory name that is one path segment and nothing else. */
const isSegment = (name: string): boolean => name !== '' && name !== '.' && name !== '..' && !/[\\/\0]/.test(name)

/** `Local State`'s profile names by directory name, in the order the browser lists them. */
function chromiumProfileNames (text: string | undefined): Map<string, string> {
  const names = new Map<string, string>()
  if (text === undefined) return names
  try {
    const cache = ((JSON.parse(text) as { profile?: { info_cache?: unknown } }).profile?.info_cache ?? {}) as Record<string, { name?: unknown } | null>
    for (const [dir, info] of Object.entries(cache)) {
      if (isSegment(dir)) names.set(dir, typeof info?.name === 'string' && info.name !== '' ? info.name : dir)
    }
  } catch {
    // Not JSON: the profile directories are found by looking for them.
  }
  return names
}

async function chromiumSources (fs: ImportFs, { browser, family, root }: BrowserRoot, realRoot: string): Promise<ImportSource[]> {
  const named = chromiumProfileNames(await fs.readText(join(root, 'Local State'), MAX_IMPORT_BYTES))
  const dirs = named.size > 0
    ? [...named.keys()]
    : (await fs.listDirs(root)).filter((name) => CHROMIUM_PROFILE_DIR.test(name)).sort()
  const found: ImportSource[] = []
  for (const name of dirs) {
    const real = await fs.realPath(join(root, name))
    if (real === undefined || !isInside(realRoot, real)) continue
    if (!await fs.isFile(join(real, 'Bookmarks')) && !await fs.isFile(join(real, 'History'))) continue
    found.push({ browser, family, profile: named.get(name) ?? name, dir: real })
  }
  return found
}

/** Firefox names its main profile after its internal folder ("default-release"); the person is shown a plain name. */
function firefoxProfileName (name: string): string {
  return name === '' || /^default(-release|-esr|-nightly)?$/i.test(name) ? 'Default profile' : name
}

async function firefoxSources (fs: ImportFs, { browser, family, root }: BrowserRoot, realRoot: string): Promise<ImportSource[]> {
  const profiles = parseProfilesIni(await fs.readText(join(root, 'profiles.ini'), MAX_IMPORT_BYTES) ?? '')
  const found: ImportSource[] = []
  for (const profile of profiles) {
    const real = await fs.realPath(profile.isRelative ? join(root, profile.path) : profile.path)
    if (real === undefined || !isInside(realRoot, real) || !await fs.isFile(join(real, 'places.sqlite'))) continue
    found.push({ browser, family, profile: firefoxProfileName(profile.name), dir: real })
  }
  return found
}

/** Every readable profile under `roots`, in the order the roots are given and each browser lists its own. */
export async function detectSources (fs: ImportFs, roots: readonly BrowserRoot[]): Promise<ImportSource[]> {
  const sources: ImportSource[] = []
  const seen = new Set<string>()
  for (const entry of roots) {
    const realRoot = await fs.realPath(entry.root)
    if (realRoot === undefined) continue
    const found = entry.family === 'chromium' ? await chromiumSources(fs, entry, realRoot) : await firefoxSources(fs, entry, realRoot)
    for (const source of found) {
      if (seen.has(source.dir)) continue
      seen.add(source.dir)
      sources.push(source)
    }
  }
  return sources
}
