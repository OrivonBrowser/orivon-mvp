// Cross-process change detection for the profiles registry. Each profile is
// its own OS process (profiles-service.ts's own header: "starting one is
// handing it to another process"), so nothing but the filesystem tells THIS
// process that another one just renamed, coloured, added or removed a
// profile, or started or stopped running. `ProfileStore.list()`/`read()`
// already read the disk fresh on every call -- there is no cache here to
// invalidate, only a reason to ask again that was missing until now.
import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { join } from 'node:path'

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
 * TWO WATCHES, because a fresh install (or one where a second profile was
 * never made) has no `profiles/` directory yet to watch, and `fs.watch`
 * throws ENOENT for a path that does not exist rather than waiting for it.
 * The root-level watch alone still sees `profiles/` get created (a rename
 * event naming it as `root`'s own new child), and retries the deeper,
 * recursive watch every time something changes at the root until that
 * succeeds -- covering the ordinary case (the directory already exists at
 * `watchProfiles` call time) on the very first attempt below, and the rare
 * one (nothing but the default profile has ever existed) the moment it
 * stops being rare.
 *
 * TOLERANT OF A WATCHED PATH VANISHING: a watcher some platforms end with an
 * 'error' event when the directory it names is removed is treated as simply
 * no longer active, never as a reason to throw -- `root` itself disappearing
 * mid-run should not happen (it is the app's own userData directory) but
 * costs nothing to shrug off the same way.
 */
export function watchProfiles (root: string, onChange: () => void): ProfilesWatcher {
  let timer: ReturnType<typeof setTimeout> | undefined
  const scheduled = (): void => {
    if (timer !== undefined) return
    timer = setTimeout(() => { timer = undefined; onChange() }, DEBOUNCE_MS)
  }

  const watchers: FSWatcher[] = []
  const profilesDir = join(root, 'profiles')
  let watchingProfilesDir = false

  function ensureProfilesWatch (): void {
    if (watchingProfilesDir) return
    try {
      const watcher = watch(profilesDir, { recursive: true }, () => { scheduled() })
      watcher.on('error', () => { watchingProfilesDir = false })
      watchers.push(watcher)
      watchingProfilesDir = true
    } catch {
      // Not made yet (ENOENT), or a platform that refuses `recursive`:
      // tried again on the next root-level event -- see the file header.
    }
  }

  try {
    const rootWatcher = watch(root, () => { scheduled(); ensureProfilesWatch() })
    rootWatcher.on('error', () => {})
    watchers.push(rootWatcher)
  } catch {
    // `root` does not exist: nothing to watch or to retry from.
  }
  ensureProfilesWatch()

  return {
    close: () => {
      if (timer !== undefined) clearTimeout(timer)
      for (const watcher of watchers) {
        try {
          watcher.close()
        } catch {
          // Already closed by its own 'error' path -- closing it again must never throw.
        }
      }
    }
  }
}
