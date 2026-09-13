// The Electron half of ADR-0007's serving mechanism -- everything in
// serve.ts is plain TypeScript against a stub LoaderStorage; this file is
// the thin layer that actually calls `session.fromPartition(...).protocol
// .handle(scheme, handler)`, mirroring electron-fetch.ts/electron-resolve.ts's
// own split (dynamic `import('electron')`, so this module stays importable
// outside a real Electron process).
//
// TWO CALLERS: subsystem.ts's afterReady calls restorePinnedServing() once,
// at startup, for every origin listPinnedOrigins() finds on disk -- this is
// what makes "offline first-run keeps working for pre-cached apps"
// (README.md) true across a restart, with no dependency on the consent-flow
// UI that does not exist yet (build step 4's other lanes). A future caller
// that just finished install() may call registerAppOrigin() directly for
// that one freshly-installed origin, immediately, in the same run.

import type { Session } from 'electron'
import { partitionFor } from '../broker/grants/origin-hash.js'
import { createAppRequestHandler } from './serve.js'
import type { AppRequestHandler } from './serve.js'
import type { LoaderStorage } from './storage.js'

/**
 * Registers `handler` as `origin`'s own scheme's handler on `appSession`.
 *
 * IDEMPOTENT ACROSS CALLS, DELIBERATELY. Electron's `protocol.handle` throws
 * "The scheme has been registered" on a second call for a scheme already
 * handled on that session (`protocol_registry.cc`'s `RegisterProtocol` uses
 * `try_emplace`, which only inserts once) -- confirmed against Electron's
 * own source rather than assumed. `partitionFor` keys a session to exactly
 * one canonical origin (origin-hash.ts), so a second registration on the
 * SAME session can only mean this same origin was reinstalled within one
 * process run; `unhandle` first, then `handle` again, so the session always
 * answers with whatever `handler` the caller just built from the freshly
 * re-verified pin, never a stale one left over from before the update.
 */
export function registerAppOrigin (appSession: Session, origin: string, handler: AppRequestHandler): void {
  const scheme = new URL(origin).protocol.replace(':', '')
  if (appSession.protocol.isProtocolHandled(scheme)) {
    appSession.protocol.unhandle(scheme)
  }
  appSession.protocol.handle(scheme, handler)
}

/**
 * Builds `origin`'s request handler (re-verifying its whole pinned tree --
 * serve.ts's own cost choice) and registers it on that origin's own
 * partition. The one thing both call sites below need done identically:
 * `restorePinnedServing`, once per origin at startup, and `subsystem.ts`'s
 * `onInstalled` hook, once, immediately after a fresh install completes
 * within the current process run.
 */
export async function registerServingFor (storage: LoaderStorage, origin: string): Promise<void> {
  const handler = await createAppRequestHandler(storage, origin)
  const { session } = await import('electron')
  registerAppOrigin(session.fromPartition(partitionFor(origin)), origin, handler)
}

/** One origin's outcome from `restorePinnedServing`, for the caller's own logging/tests. */
export interface RestoredOrigin {
  readonly origin: string
  readonly ok: boolean
}

/**
 * For every origin `storage` holds a pin for, registers its serving (via
 * `registerServingFor` above). Called once, at startup, so a previously-
 * installed app is served from cache again without waiting for anything to
 * call `Loader.load()` first.
 *
 * One origin's failure (a corrupted pin, an unreadable asset) is logged and
 * does not stop the rest -- the same "one bad entry does not take down
 * everything else" stance `runAfterReady` (main/registry.ts) already takes
 * for subsystems, applied here per app instead of per subsystem.
 */
export async function restorePinnedServing (storage: LoaderStorage): Promise<readonly RestoredOrigin[]> {
  const origins = await storage.listPinnedOrigins()
  const results: RestoredOrigin[] = []

  for (const origin of origins) {
    try {
      await registerServingFor(storage, origin)
      results.push({ origin, ok: true })
    } catch (error) {
      console.error('[loader] failed to restore cache-serving for', origin, error)
      results.push({ origin, ok: false })
    }
  }

  return results
}
