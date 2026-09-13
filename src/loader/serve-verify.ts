// Whole-bundle re-verification -- ADR-0007's "the cached tree is
// re-verified at every load, not only at fetch." Split out of serve.ts
// (Rule 2) since it is independently testable against a stub LoaderStorage.
//
// THE COST CHOICE, RECORDED HERE BECAUSE THE CODE IS WHERE IT IS SPENT: see
// src/loader/README.md's Design notes for the full reasoning. Short version --
// this re-hashes the ENTIRE pinned tree once, at handler-creation time (once
// per app per Electron process launch, since `protocol.handle` registrations
// do not survive a restart), rather than re-hashing one leaf on every single
// request. "Between runs" (the ADR's own phrase) is exactly what this
// catches; a file changed on disk mid-session, after this check already ran,
// is not.
//
// REUSES bundle-hash.ts's OWN bundleTree() rather than re-deriving a leaf
// digest here (Rule 3) -- that construction is a one-way door
// (bundle-hash.ts's own header) and this file has no business holding a
// second copy of it, correct or not.

import { bundleTree } from '../broker/policy/bundle-hash.js'
import type { BundleEntry } from '../broker/policy/bundle-hash.js'
import type { PinRecord } from '../broker/policy/pin.js'
import type { LoaderStorage } from './storage.js'

/**
 * True only if every asset `pin` claims is still readable AND the tree they
 * form together still hashes to `pin.bundleHash`. False for anything else --
 * a missing/unreadable asset, a changed byte anywhere, or a tree that no
 * longer satisfies `bundleTree()`'s own structural rules (which cannot
 * happen for a tree that was ever valid, but a corrupted read is not ruled
 * out by this file alone).
 *
 * DELIBERATELY ALL-OR-NOTHING. `pin.bundleHash` is this bundle's ONE
 * identity (ADR-0009); a single changed byte anywhere in the tree is not
 * "this one file is stale", it is "this is not the bundle that was pinned",
 * and the caller's answer to that is the same either way: nothing from this
 * origin's cache is servable until it is reinstalled.
 */
export async function verifyPinnedTree (storage: LoaderStorage, origin: string, pin: PinRecord): Promise<boolean> {
  const entries: BundleEntry[] = []
  for (const asset of pin.assets) {
    const content = await storage.readAsset(origin, asset.path)
    if (content === undefined) return false
    entries.push({ path: asset.path, content })
  }

  try {
    const tree = await bundleTree(entries)
    return tree.root === pin.bundleHash
  } catch {
    // bundleTree() rejects a structurally invalid entry set (duplicate/
    // colliding paths, a missing manifest leaf, an over-limit bundle) --
    // pin.assets came from parsePinRecord, which already enforces the same
    // rules, so reaching this branch means the disk read above produced
    // something parsePinRecord would not have accepted. Fail closed, the
    // same as any other verification failure.
    return false
  }
}
