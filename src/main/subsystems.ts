// THE APPEND POINT.
//
// Adding a subsystem is two lines: an import above, and one entry in the array
// below. Nothing else in src/main/ changes.
//
// DO NOT ADD LOGIC TO THIS FILE. No conditionals, no environment checks, no
// ordering cleverness -- those reintroduce exactly the merge conflicts the
// registry exists to remove, because two streams editing the same conditional
// is a conflict while two streams appending to a list is not. If a subsystem
// needs conditional behaviour, that belongs inside the subsystem.
//
// Which stream owns which entry: docs/development/parallel-work.md.
import type { Subsystem } from './registry.js'
import { brokerIpcSubsystem } from '../broker/ipc.js'
import { loaderSubsystem } from '../loader/subsystem.js'
import { telemetrySubsystem } from '../telemetry/runner.js'

export const subsystems: Subsystem[] = [
  brokerIpcSubsystem, // build step 2: broker -> src/broker/
  // build step 3: shim      -> src/shim/
  loaderSubsystem, // build step 4: loader -> src/loader/
  // build step 6: trust     -> src/trust/
  // build step 7: nostr     -> src/nostr/
  telemetrySubsystem // build step 8: telemetry -> src/telemetry/
]
