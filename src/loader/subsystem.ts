// The loader's entry in src/main/subsystems.ts's registry -- see that
// file's header (append-only, one import + one array entry) and
// docs/development/parallel-work.md.
//
// BUILDS AND PUBLISHES A REAL LOADER, and restores ADR-0007 cache-serving for
// every app already pinned on this machine.
//
// load() now has a real caller: the discovery trigger -- the `<link
// rel="orivon-manifest">` hint listener -- is wired in src/main/
// manifest-hint.ts, a separate subsystem listed after this one, since it is
// shell UI rather than loader construction. It is the ONLY trigger: there is
// no "Open as app" action, because a Web3site is the URL, not a thing a user
// converts a website into (capability-api.md's 2026-09-03 correction).
//
// dev-serve.ts's hook is the one e2e-only exception -- reachable from
// Playwright's evaluate(), never from a real page -- and it drives serving
// directly rather than load(), because install-origin.ts's
// https/public-unicast-only rule (A46) has no exception a hermetic loopback
// suite could satisfy.
//
// MUST BE LISTED AFTER brokerIpcSubsystem in subsystems.ts (that file's own
// header says so): S4-6 made this load-bearing rather than merely prudent --
// ctx.broker now reads the live grant ledger for the served bundle's CSP
// (electron/serve.ts's registerServingFor), so an undefined ctx.broker here
// would mean every app's connect-src silently narrows to 'self' only.

import { electronFetch } from './electron/fetch.js'
import { electronResolveHost } from './electron/resolve.js'
import { registerServingFor, restorePinnedServing } from './electron/serve.js'
import { maybeInstallDevServeHook } from './dev-serve.js'
import { nodeLoaderStorage } from './cache/node-storage.js'
import { UPDATE_CHECK_INTERVAL_MS, createLoader } from './index.js'
import { publishLoader, type Subsystem } from '../main/registry.js'
import { ethContentAddress } from '../main/verifier/verifier-subsystem.js'

export const loaderSubsystem: Subsystem = {
  name: 'loader',
  afterReady: async (ctx) => {
    const storage = nodeLoaderStorage(ctx.app.getPath('userData'))
    const loader = createLoader({
      fetch: electronFetch,
      storage,
      now: () => Date.now(),
      // T12/A46: Chromium's OWN resolver (net.resolveHost), the SAME one
      // electronFetch's net.fetch will consult -- deliberately NOT
      // node-adapters.ts's node:dns-based resolveHost (the broker's own
      // outbound tcp.connect uses that one correctly, because it dials with
      // real node:net sockets; this loader dials nothing of the kind). See
      // electron/resolve.ts's own header for why these are two
      // implementations of two different things, not a Rule 3 violation.
      resolve: electronResolveHost,
      // ADR-0007's serve-from-cache half: whatever eventually calls
      // load() (a future consent-flow lane) gets serving registered for
      // that origin immediately, in this same run -- restorePinnedServing
      // below is the OTHER half, covering an app installed in a PRIOR run.
      // `ctx.broker` is threaded through so the served bundle's CSP
      // (S4-6, connect-src.ts) reads this origin's LIVE grant on every
      // request rather than none at all -- see registerServingFor's own
      // doc for why `undefined` (no broker subsystem this run) still
      // serves the app correctly, just with a narrower header.
      onInstalled: async (origin) => { await registerServingFor(storage, origin, ctx.broker) },
      updateCheckIntervalMs: UPDATE_CHECK_INTERVAL_MS,
      contentAddress: ethContentAddress
    })
    publishLoader(ctx, loader)
    maybeInstallDevServeHook(async (origin) => { await registerServingFor(storage, origin, ctx.broker) })

    // ADR-0007's serve-from-cache half (electron/serve.ts): restores
    // protocol.handle serving for every app this machine already has a
    // pin for, before anything navigates -- so a previously-installed app
    // keeps working offline across a restart, with no dependency on the
    // consent-flow UI that triggers a fresh load() (that UI is a different
    // build step 4 lane's work, not this subsystem's).
    await restorePinnedServing(storage, ctx.broker)
  }
}
