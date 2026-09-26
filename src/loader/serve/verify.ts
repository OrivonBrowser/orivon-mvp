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
// STREAMED, leaf by leaf (leaf-hash.ts): no asset is ever read whole, so
// verifying a 512 MiB bundle costs a read of it, not 512 MiB of memory. The
// leaf construction and the root stay bundle-hash.ts's own
// (`leafPrefix`, `bundleTreeFromLeaves`) -- never a second copy here.

import { bundleTreeFromLeaves } from '../../broker/policy/bundle-hash.js'
import type { LeafEntry } from '../../broker/policy/bundle-hash.js'
import type { PinRecord } from '../../broker/policy/pin.js'
import { leafOf } from '../leaf-hash.js'
import type { LoaderStorage } from '../cache/storage.js'

/**
 * True only if every asset `pin` claims is still readable and hashes to its
 * pinned leaf, AND those leaves together still produce `pin.bundleHash`.
 * False for anything else -- a missing/unreadable asset, a changed byte
 * anywhere, a pin record whose leaves no longer add up to its own root, or
 * a set bundleTreeFromLeaves() refuses.
 *
 * DELIBERATELY ALL-OR-NOTHING. `pin.bundleHash` is this bundle's ONE
 * identity (ADR-0009); a single changed byte anywhere in the tree is not
 * "this one file is stale", it is "this is not the bundle that was pinned".
 */
export async function verifyPinnedTree (storage: LoaderStorage, origin: string, pin: PinRecord): Promise<boolean> {
  const leaves: LeafEntry[] = []
  for (const asset of pin.assets) {
    const stream = await storage.readAssetStream(origin, asset.path)
    if (stream === undefined) return false
    let leaf: string
    try {
      leaf = await leafOf(asset.path, stream.byteLength, stream.chunks)
    } catch {
      return false
    }
    if (leaf !== asset.leaf) return false
    leaves.push({ path: asset.path, byteLength: stream.byteLength, leaf })
  }

  try {
    return (await bundleTreeFromLeaves(leaves)).root === pin.bundleHash
  } catch {
    // pin.assets came from parsePinRecord, which enforces the same structural
    // rules -- reaching this means the disk produced something that record
    // would not have accepted. Fail closed like any other mismatch.
    return false
  }
}
