// The loader's entry in src/main/subsystems.ts's registry -- see that
// file's header (append-only, one import + one array entry) and
// docs/development/parallel-work.md.
//
// DELIBERATELY INERT: no beforeReady, no afterReady. Wiring createLoader to
// real Electron effects -- a real `fetch`, a real disk-backed LoaderStorage,
// and a real discovery trigger (the `<link rel="orivon-manifest">` listener
// or "Open as app" menu action, src/loader/README.md) -- is explicitly out
// of this lane's scope (this lane builds createLoader itself, injected and
// unit-testable, not the shell wiring around it). Registering the name now,
// with no behaviour, means the append point (src/main/subsystems.ts) only
// has to change once -- a later PR adds `afterReady` here, not a new entry
// in the array.
//
// storage.ts's own header records the matching gap on the other side: no
// real node:fs-backed LoaderStorage ships yet either. Both are "broker/main
// work still needed to back this for real", named explicitly rather than
// silently left for someone to discover.

import type { Subsystem } from '../main/registry.js'

export const loaderSubsystem: Subsystem = {
  name: 'loader'
}
