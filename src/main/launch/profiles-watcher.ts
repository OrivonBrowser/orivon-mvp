// Cross-process change detection for the profiles registry. Each profile is
// its own OS process (profiles-service.ts's own header: "starting one is
// handing it to another process"), so nothing but the filesystem tells THIS
// process that another one just renamed, coloured, added or removed a
// profile, or started or stopped running. `ProfileStore.list()`/`read()`
// already read the disk fresh on every call: this is only a reason to ask
// again.
//
// NON-RECURSIVE EVERYWHERE, AND FILTERED BY NAME. A profile's own directory
// (`profiles/<id>/`) IS that profile's whole Chromium userData -- caches,
// IndexedDB, CacheStorage -- and web content creates directories under it
// freely while it runs. A recursive watch there adds an inotify watch per
// directory (a real exhaustion risk on Linux) and fires on every cache
// write, in every OTHER running profile's own process, none of which the
// registry cares about. What the registry is actually made of is `profiles/`
// itself (a profile directory appearing or disappearing) plus, inside each
// existing one, exactly `profile.json` and the running/lock marker
// (`ProfileStore`'s own `PROFILE_FILE`/`RUNNING_FILE`) -- watched by name,
// never by recursing into what else lives there. `root` itself holds the
// SAME hazard one level up (settings.json, history.db-wal, Cookies-journal,
// ...) for the default profile, so it is filtered the same way.
import { readdirSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { join } from 'node:path'

/** `ProfileStore`'s own two file names, duplicated as plain strings rather
 * than imported so this stays a leaf module -- `profile-store.ts` already
 * exports `registryDir`, the one value this file needs from it. */
const REGISTRY_FILES = new Set(['profile.json', '.orivon-running'])
/** `root`'s own filter: the default profile's registry files, plus the one
 * name whose appearance means a second profile was just made. */
const ROOT_NAMES = new Set([...REGISTRY_FILES, 'profiles'])

/** An atomic write (a temp file, then a rename) fires more than one raw fs
 * event for a single logical change; this folds a burst into one call. */
const DEBOUNCE_MS = 200

export interface ProfilesWatcher {
  /** Stops every watcher this started. Safe to call more than once. */
  close: () => void
}

/**
 * `root` is `ProfileStore.registryDir` -- the directory every profile's
 * `profile.json` sits under, directly for the default profile or one level
 * down in `profiles/<id>/` for any other.
 *
 * THREE KINDS OF WATCH, ALL NON-RECURSIVE:
 *   1. `root` itself, filtered to `profile.json`/the running marker (the
 *      DEFAULT profile's own, since it lives directly in `root`) and to the
 *      literal name `profiles` -- not itself registry data, but its
 *      appearance is what starts (2) the first time a second profile is
 *      ever made.
 *   2. `root/profiles`, unfiltered: ANY direct child appearing, disappearing
 *      or being renamed there (`ProfileStore.create`'s `mkdirSync`,
 *      `remove`'s rename-then-delete) is by itself a change to the list of
 *      profiles, whatever its name -- and is also when the per-profile
 *      watches (3) are reconciled against whatever directories exist now.
 *   3. One watch per profile directory, filtered the same names as `root`'s
 *      own -- this is the one that would otherwise recurse into a profile's
 *      caches; kept to exactly its own `profile.json` and running marker.
 *
 * TOLERANT OF A WATCHED PATH VANISHING: some platforms end a watch with an
 * 'error' event when the directory it names is removed; treated as simply
 * no longer active, never as a reason to throw. `root/profiles` itself not
 * existing yet (no second profile has ever been made) is the ordinary,
 * expected first state, not a failure either -- (1) alone still sees it get
 * created, at which point (2) starts.
 */
export function watchProfiles (root: string, onChange: () => void): ProfilesWatcher {
  let timer: ReturnType<typeof setTimeout> | undefined
  const scheduled = (): void => {
    if (timer !== undefined) return
    timer = setTimeout(() => { timer = undefined; onChange() }, DEBOUNCE_MS)
  }

  const profilesDir = join(root, 'profiles')
  const others: FSWatcher[] = []
  const perProfile = new Map<string, FSWatcher>()

  /** A single watch, filtered to `names` -- `filename === null` (a platform
   * that does not report one) fails open rather than silently missing a
   * real change. */
  function watchNamed (dir: string, names: ReadonlySet<string>): FSWatcher | undefined {
    try {
      const watcher = watch(dir, (_event, filename) => {
        if (filename === null || names.has(filename)) scheduled()
      })
      watcher.on('error', () => {})
      return watcher
    } catch {
      // ENOENT (removed, or not made yet): nothing to watch until whatever
      // names it is noticed again by the watch one level up.
      return undefined
    }
  }

  function reconcilePerProfileWatches (): void {
    let names: string[]
    try {
      names = readdirSync(profilesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      names = [] // profiles/ does not exist (yet, or any more): nothing under it to watch.
    }
    const current = new Set(names)
    for (const [name, watcher] of perProfile) {
      if (!current.has(name)) { watcher.close(); perProfile.delete(name) }
    }
    for (const name of names) {
      if (perProfile.has(name)) continue
      const watcher = watchNamed(join(profilesDir, name), REGISTRY_FILES)
      if (watcher !== undefined) perProfile.set(name, watcher)
    }
  }

  let watchingProfilesDir = false
  function ensureProfilesDirWatch (): void {
    if (watchingProfilesDir) return
    try {
      const watcher = watch(profilesDir, () => { scheduled(); reconcilePerProfileWatches() })
      watcher.on('error', () => { watchingProfilesDir = false })
      others.push(watcher)
      watchingProfilesDir = true
      // Whatever is in profiles/ already raised no event on the new watch: a profile made together with profiles/ itself is found here.
      reconcilePerProfileWatches()
    } catch {
      // Not made yet: retried on the next root-level event that names it -- see ensureProfilesDirWatch's own caller below.
    }
  }

  try {
    const rootWatcher = watch(root, (_event, filename) => {
      if (filename === null || ROOT_NAMES.has(filename)) scheduled()
      if (filename === null || filename === 'profiles') ensureProfilesDirWatch()
    })
    rootWatcher.on('error', () => {})
    others.push(rootWatcher)
  } catch {
    // `root` does not exist: nothing to watch or to retry from.
  }
  ensureProfilesDirWatch()
  reconcilePerProfileWatches()

  return {
    close: () => {
      if (timer !== undefined) clearTimeout(timer)
      for (const watcher of [...others, ...perProfile.values()]) {
        try {
          watcher.close()
        } catch {
          // Already closed by its own 'error' path -- closing it again must never throw.
        }
      }
      perProfile.clear()
    }
  }
}
