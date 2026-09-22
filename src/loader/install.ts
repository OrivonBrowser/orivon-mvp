// Persisting an accepted bundle: staged files committed into the code cache,
// then the pin record. Split out of index.ts (Rule 2), which keeps the
// update decision; this file only ever runs once that decision said
// "install". See README.md's Design notes for what is written, when, and
// what a crash part-way through leaves behind.

import type { Manifest } from '../contracts/index.js'
import type { BundleTree } from '../broker/policy/bundle-hash.js'
import { fromBundleTree } from '../broker/policy/pin.js'
import type { PinRecord } from '../broker/policy/pin.js'
import type { StagedAsset } from './fetch-asset.js'
import type { CreateLoaderOptions, LoadInstalled, LoadRejected } from './index.js'
import { leafOf } from './leaf-hash.js'
import type { LoaderStorage } from './storage.js'
import { warnUndeclaredReferences } from './undeclared-assets.js'

/** Does the file already in the code cache at `path` hash to `leaf`? False for anything unreadable -- the caller then rewrites it. */
async function onDiskLeafIs (storage: LoaderStorage, origin: string, path: string, leaf: string): Promise<boolean> {
  const stream = await storage.readAssetStream(origin, path)
  if (stream === undefined) return false
  try {
    return await leafOf(path, stream.byteLength, stream.chunks) === leaf
  } catch {
    return false
  }
}

/**
 * Commits every staged file whose bytes differ from what the code cache
 * already holds at that path, then writes the pin -- unless the bundle is
 * the one already pinned, which keeps its record (and its `pinnedAt`).
 * Comparing against the bytes on DISK, never the old pin's leaf, is what
 * lets a corrupted cache heal: a file that no longer matches is rewritten
 * even when its pinned leaf is unchanged.
 *
 * `pruneAssets` after writing deletes whatever a PREVIOUS pin left behind
 * that the new bundle no longer declares (A58). Skipped for a fresh
 * install: nothing could have been left behind.
 */
async function install (
  storage: LoaderStorage,
  canonicalOrigin: string,
  manifest: Manifest,
  tree: BundleTree,
  entries: readonly StagedAsset[],
  now: number,
  existingPin: PinRecord | null | undefined
): Promise<{ readonly pin: PinRecord, readonly changed: boolean }> {
  let changed = false
  for (const entry of entries) {
    if (await onDiskLeafIs(storage, canonicalOrigin, entry.path, entry.leaf)) continue
    await storage.commitStaged(canonicalOrigin, entry.staged, entry.path)
    changed = true
  }
  const unchanged = existingPin !== null && existingPin !== undefined && existingPin.bundleHash === tree.root
  const pin = unchanged ? existingPin : fromBundleTree(canonicalOrigin, tree.root, tree.assets, manifest.version, now)
  if (!unchanged) {
    if (existingPin !== undefined) await storage.pruneAssets(canonicalOrigin, entries.map((entry) => entry.path))
    await storage.writePin(canonicalOrigin, pin)
    changed = true
    await warnUndeclaredReferences(storage, canonicalOrigin, manifest, tree)
  }
  await storage.clearStaging(canonicalOrigin)
  return { pin, changed }
}

/**
 * Wraps install() so a storage failure resolves to one of load()'s own
 * documented outcomes instead of an uncaught exception, then fires
 * `options.onInstalled` -- exactly once per real install, never on a path
 * that only returns a prompt outcome; a failure there is logged, not
 * thrown (see `CreateLoaderOptions.onInstalled`).
 *
 * `existingPin`: the parsed pin this install replaces, `null` for one that
 * exists but did not parse, `undefined` when nothing was ever pinned (TOFU).
 */
export async function installAndNotify (
  options: CreateLoaderOptions,
  canonicalOrigin: string,
  manifest: Manifest,
  tree: BundleTree,
  entries: readonly StagedAsset[],
  existingPin: PinRecord | null | undefined
): Promise<LoadInstalled | LoadRejected> {
  let installed: { readonly pin: PinRecord, readonly changed: boolean }
  try {
    installed = await install(options.storage, canonicalOrigin, manifest, tree, entries, options.now(), existingPin)
  } catch (error) {
    // The raw message is a node:fs one and carries the absolute host path it
    // failed on. policy/paths.ts's CONFINEMENT_ERROR_CODE states the rule:
    // the detail is for the local log, and a path oracle is a hazard on its
    // own, so what is RETURNED names the origin and the stage and nothing
    // about this machine.
    console.error('[loader] install failed', canonicalOrigin, error)
    return { outcome: 'rejected', reason: `the bundle for ${canonicalOrigin} could not be written to local storage` }
  }
  if (options.onInstalled !== undefined) {
    try {
      await options.onInstalled(canonicalOrigin)
    } catch (error) {
      console.error('[loader] onInstalled hook failed', canonicalOrigin, error)
    }
  }
  return { outcome: 'installed', canonicalOrigin, manifest, pin: installed.pin }
}
