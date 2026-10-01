// Removing and switching off an installed extension. Both run under
// `withRegistryLock` (registry-runner.ts), so an install landing on the same
// `userDataPath` never reads a registry either one is about to rewrite.

import { rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { withRegistryLock, writeRegistry } from './registry-runner.js'
import { clearPersistedRuleState } from './dnr/dnr-runner.js'
import { restoreBaseManifest } from './effective-manifest-runner.js'
import type { InstallContext } from './install-runner.js'

/** Runs entirely under `withRegistryLock` (registry-runner.ts's own doc):
 * an install landing on the same `userDataPath` while this is in flight
 * reads a registry that already reflects this removal, or this reads one
 * that already reflects that install -- never a copy read before the
 * other's own write. */
export async function uninstall (ctx: InstallContext, id: string): Promise<void> {
  await withRegistryLock(ctx.userDataPath, (registry) => {
    const entry = registry.find((candidate) => candidate.id === id)
    if (entry === undefined) return
    ctx.session.extensions.removeExtension(id)
    rmSync(entry.path, { recursive: true, force: true })
    // Chrome clears an uninstalled extension's dynamic rules and enabled-
    // ruleset choice too. The slot's key.pub stays: a reinstall into the
    // same slot must resolve to the same id.
    clearPersistedRuleState(dirname(entry.path))
    restoreBaseManifest(dirname(entry.path), undefined)
    ctx.prefs?.forget(id)
    writeRegistry(ctx.userDataPath, registry.filter((candidate) => candidate.id !== id))
  })
}

/**
 * Electron has no "disable" for a loaded extension, only load/unload
 * (../README.md's Design notes): disabling removes it from the session and
 * flips `enabled: false` in the registry, so extensions-subsystem.ts simply
 * skips it on the next boot; enabling loads it again right away. Runs
 * entirely under `withRegistryLock`, the same reason `uninstall` above does.
 */
export async function setEnabled (ctx: InstallContext, id: string, enabled: boolean): Promise<void> {
  await withRegistryLock(ctx.userDataPath, async (registry) => {
    const entry = registry.find((candidate) => candidate.id === id)
    if (entry === undefined || entry.enabled === enabled) return
    if (enabled) {
      await ctx.session.extensions.loadExtension(entry.path, { allowFileAccess: false })
    } else {
      ctx.session.extensions.removeExtension(id)
    }
    writeRegistry(ctx.userDataPath, registry.map((candidate) => candidate.id === id ? { ...candidate, enabled } : candidate))
  })
}
