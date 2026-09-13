// The loader's entry in src/main/subsystems.ts's registry -- see that
// file's header (append-only, one import + one array entry) and
// docs/development/parallel-work.md.
//
// BUILDS AND PUBLISHES A REAL LOADER, and restores ADR-0007 cache-serving
// for every app already pinned on this machine. NOTHING IN PRODUCTION CALLS
// load() YET -- the discovery trigger (the `<link rel="orivon-manifest">`
// hint listener, src/loader/README.md) is deliberately separate work, since
// it is shell UI, not loader construction. `dev-serve.ts`'s hook is the one
// e2e-only exception -- reachable only from Playwright's `evaluate()`,
// never from a real page -- and it drives serving directly, not load(),
// because install-origin.ts's https/public-unicast-only rule (A46) has no
// exception a hermetic loopback e2e suite could ever satisfy.
//
// MUST BE LISTED AFTER brokerIpcSubsystem in subsystems.ts (that file's own
// header says so) -- not because this loader reads ctx.broker itself today,
// but because whatever eventually calls load() will, and getting the
// ordering right once now costs nothing.

import { electronFetch } from './electron-fetch.js'
import { electronResolveHost } from './electron-resolve.js'
import { registerServingFor, restorePinnedServing } from './electron-serve.js'
import { maybeInstallDevServeHook } from './dev-serve.js'
import { nodeLoaderStorage } from './node-storage.js'
import { createLoader } from './index.js'
import { publishLoader, type Subsystem } from '../main/registry.js'

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
      // electron-resolve.ts's own header for why these are two
      // implementations of two different things, not a Rule 3 violation.
      resolve: electronResolveHost,
      // ADR-0007's serve-from-cache half: whatever eventually calls
      // load() (a future consent-flow lane) gets serving registered for
      // that origin immediately, in this same run -- restorePinnedServing
      // below is the OTHER half, covering an app installed in a PRIOR run.
      onInstalled: async (origin) => { await registerServingFor(storage, origin) }
    })
    publishLoader(ctx, loader)
    maybeInstallDevServeHook(async (origin) => { await registerServingFor(storage, origin) })

    // ADR-0007's serve-from-cache half (electron-serve.ts): restores
    // protocol.handle serving for every app this machine already has a
    // pin for, before anything navigates -- so a previously-installed app
    // keeps working offline across a restart, with no dependency on the
    // consent-flow UI that triggers a fresh load() (that UI is a different
    // build step 4 lane's work, not this subsystem's).
    await restorePinnedServing(storage)
  }
}
