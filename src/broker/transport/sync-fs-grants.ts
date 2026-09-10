// Mirrors "does this origin hold a live fs grant" for ./sync-fs-policy.ts,
// without touching ../index.ts's private GrantLedger -- see ./sync-fs.ts's
// header for why that file is out of this lane's reach.
//
// SAFE BECAUSE OF WHEN IT OBSERVES, NOT WHAT IT STORES. ../index.ts's
// createBroker mutates the ledger (`ledger.grant()`/`ledger.revoke()`)
// BEFORE either async `grant`/`revoke` function's first `await` -- see
// those two methods' own bodies. Calling an async function always runs its
// body synchronously up to that point before the Promise it returns even
// exists, so by the time `broker.grant(...)`/`broker.revoke(...)` HAS BEEN
// CALLED (not yet resolved -- called), the real ledger has already been
// mutated. Wrapping those two methods, and publishing only the wrapped
// object before any caller can reach the unwrapped one, therefore observes
// every grant/revoke at the exact moment it happens, with no window where
// this mirror and the real ledger could disagree.
//
// Nothing else can ever change a grant: `Broker.grant`/`revoke` are the
// ONLY way one is created, replaced or withdrawn (broker-contracts.ts's own
// doc on both), so wrapping both covers every path there is -- this is not
// a second, independently-computed decision, only a passive readback of
// values `Broker`'s own public interface already returns.
//
// `fs` carries no patterns (manifest.ts's FsCapability) -- ../index.ts's own
// `confineForOrigin` checks presence only -- so this mirrors PRESENCE plus
// the live grant's id, needed only to tell a revoke of THIS grant apart from
// a revoke of some other capability's.

import type { Broker } from '../broker-contracts.js'
import { originFromUrl } from '../policy/origin.js'

export interface SyncFsGrantMirror {
  readonly broker: Broker
  readonly hasFsGrant: (origin: string) => boolean
}

/**
 * `originFromUrl` is idempotent, so re-applying it to an already-canonical
 * origin (e.g. one `originFromSenderFrame` already produced) is a no-op --
 * this keeps this mirror's keys agreeing with ../index.ts's own `canonical`,
 * which normalises every origin it is given the same way before touching
 * the ledger.
 */
function canonicalOrThrow (origin: string): string {
  const key = originFromUrl(origin)
  if (key === null) throw new Error('sync-fs-grants: origin does not parse as an origin')
  return key
}

export function wrapBrokerForSyncFsGrants (broker: Broker): SyncFsGrantMirror {
  const fsGrantIdByOrigin = new Map<string, string>()

  const wrapped: Broker = {
    ...broker,
    grant: async (origin, capability, patterns) => {
      const record = await broker.grant(origin, capability, patterns)
      if (capability === 'fs') fsGrantIdByOrigin.set(canonicalOrThrow(origin), record.id)
      return record
    },
    revoke: async (origin, grantId) => {
      const key = canonicalOrThrow(origin)
      if (fsGrantIdByOrigin.get(key) === grantId) fsGrantIdByOrigin.delete(key)
      await broker.revoke(origin, grantId)
    }
  }

  return {
    broker: wrapped,
    hasFsGrant: (origin) => fsGrantIdByOrigin.has(origin)
  }
}
