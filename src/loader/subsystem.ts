// The loader's entry in src/main/subsystems.ts's registry -- see that
// file's header (append-only, one import + one array entry) and
// docs/development/parallel-work.md.
//
// BUILDS AND PUBLISHES A REAL LOADER; STILL NOTHING CALLS load(). The real
// Fetch (electron-fetch.ts) and real LoaderStorage (node-storage.ts) both
// now exist -- this is the append-point wiring that constructs one Loader
// from them and makes it reachable, the same way brokerIpcSubsystem
// publishes the one Broker. What is still missing is the discovery trigger
// itself -- the `<link rel="orivon-manifest">` hint listener
// (src/loader/README.md). It is the ONLY trigger: there is no "Open as app"
// action -- a Web3site is the URL, not a thing a user converts a website
// into (capability-api.md's 2026-09-03 correction). Wiring it is
// deliberately separate work, since it is shell UI, not loader construction.
//
// MUST BE LISTED AFTER brokerIpcSubsystem in subsystems.ts (that file's own
// header says so) -- not because this loader reads ctx.broker itself today,
// but because whatever eventually calls load() will, and getting the
// ordering right once now costs nothing.

import { electronFetch } from './electron-fetch.js'
import { electronResolveHost } from './electron-resolve.js'
import { nodeLoaderStorage } from './node-storage.js'
import { createLoader } from './index.js'
import { publishLoader, type Subsystem } from '../main/registry.js'

export const loaderSubsystem: Subsystem = {
  name: 'loader',
  afterReady: (ctx) => {
    const loader = createLoader({
      fetch: electronFetch,
      storage: nodeLoaderStorage(ctx.app.getPath('userData')),
      now: () => Date.now(),
      // T12/A46/F2: Chromium's OWN resolver (net.resolveHost), the SAME one
      // electronFetch's net.fetch will consult -- deliberately NOT
      // node-adapters.ts's node:dns-based resolveHost (the broker's own
      // outbound tcp.connect uses that one correctly, because it dials with
      // real node:net sockets; this loader dials nothing of the kind). See
      // electron-resolve.ts's own header for why these are two
      // implementations of two different things, not a Rule 3 violation.
      resolve: electronResolveHost
    })
    publishLoader(ctx, loader)
  }
}
