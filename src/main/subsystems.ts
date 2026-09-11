// THE APPEND POINT.
//
// Adding a subsystem is two lines: an import above, and one entry in the array
// below. Nothing else in src/main/ changes -- WITH ONE EXCEPTION: where your
// entry goes in the array, if your subsystem reads ctx.broker.
//
// ctx.broker AND ctx.loader ARE ORDER-DEPENDENT, the same way. runAfterReady
// (registry.ts) runs this array in order; brokerIpcSubsystem is the only
// entry that writes ctx.broker, loaderSubsystem the only one that writes
// ctx.loader. List your entry AFTER whichever one you need to read -- before
// it, you get `undefined`, silently, with no merge conflict and no compile
// error. Read the published value; never build your own Broker or Loader
// (registry.ts's own doc on each says why a second one is a real hazard, not
// a style preference).
//
// DO NOT ADD LOGIC TO THIS FILE OTHERWISE. No conditionals, no environment
// checks, no ordering cleverness beyond the one rule above -- those
// reintroduce exactly the merge conflicts the registry exists to remove,
// because two streams editing the same conditional is a conflict while two
// streams appending to a list is not. If a subsystem needs conditional
// behaviour, that belongs inside the subsystem.
//
// Which stream owns which entry: docs/development/parallel-work.md.
import type { Subsystem } from './registry.js'
import { permissionGateSubsystem } from './permission-gate.js'
import { brokerIpcSubsystem } from '../broker/transport/ipc.js'
import { devGrantSubsystem } from './dev-grant.js'
import { requestGrantSubsystem } from './request-grant-subsystem.js'
import { loaderSubsystem } from '../loader/subsystem.js'
import { telemetrySubsystem } from '../telemetry/runner.js'

export const subsystems: Subsystem[] = [
  // Listed first, ahead of everything else here: its beforeReady attaches
  // a listener that must exist before Electron can create ANY session,
  // including one a later entry's own beforeReady might trigger. Reads
  // neither ctx.broker nor ctx.loader, so it has no ordering constraint
  // from either of those -- only this one, self-imposed.
  permissionGateSubsystem, // security -> src/main/permission-gate.ts
  brokerIpcSubsystem, // build step 2: broker -> src/broker/. Writes ctx.broker -- anything reading it must be listed below this line.
  devGrantSubsystem, // queue item 0.3: dev-only grant hook -> src/main/dev-grant.ts. Reads ctx.broker -- must stay below brokerIpcSubsystem.
  requestGrantSubsystem, // queue item 4.1: app.requestGrant's mechanism -> src/main/request-grant.ts. Reads ctx.broker -- must stay below brokerIpcSubsystem.
  // build step 3: shim      -> src/shim/
  loaderSubsystem, // build step 4: loader -> src/loader/
  // build step 6: trust     -> src/trust/
  // build step 7: nostr     -> src/nostr/
  telemetrySubsystem // build step 8: telemetry -> src/telemetry/
]
