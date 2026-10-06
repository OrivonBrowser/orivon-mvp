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
import { permissionGateSubsystem } from './sessions/permission-gate.js'
import { sessionAttributionSubsystem } from './sessions/session-attribution.js'
import { localFilesSubsystem } from './local-files/local-files-subsystem.js'
import { verifierSubsystem } from './verifier/verifier-subsystem.js'
import { signInIdentitySubsystem } from './shell/sign-in-identity-headers.js'
import { extensionsSubsystem } from './extensions/extensions-subsystem.js'
import { brokerIpcSubsystem } from '../broker/transport/ipc.js'
import { devGrantSubsystem } from './dev/dev-grant.js'
import { requestGrantSubsystem } from './consent/request-grant-subsystem.js'
import { embedSubsystem } from './embed/embed-subsystem.js'
import { childrenSubsystem } from './children/children-subsystem.js'
import { loaderSubsystem } from '../loader/subsystem.js'
import { appInstallSubsystem } from './install/app-install-subsystem.js'
import { manifestHintSubsystem } from './install/manifest-hint.js'
import { telemetrySubsystem } from '../telemetry/runner.js'
import { pagesSubsystem } from './pages/pages-subsystem.js'

export const subsystems: Subsystem[] = [
  // Listed first, ahead of everything else here: its beforeReady attaches
  // a listener that must exist before Electron can create ANY session,
  // including one a later entry's own beforeReady might trigger. Reads
  // neither ctx.broker nor ctx.loader, so it has no ordering constraint
  // from either of those -- only this one, self-imposed.
  permissionGateSubsystem, // security -> src/main/permission-gate.ts
  // Publishes ctx.senderAttributed -> src/main/sessions/session-attribution.ts.
  // Reads neither ctx.broker nor ctx.loader (its closure reads ctx.broker
  // lazily, once a real request needs it), but must stay ABOVE
  // brokerIpcSubsystem: that subsystem reads ctx.senderAttributed itself.
  sessionAttributionSubsystem,
  // Where documents opened from this computer run, and what a session answers `file:` with -> src/main/local-files/. Reads ctx.broker only when a request arrives.
  localFilesSubsystem,
  verifierSubsystem, // .eth names: resolver rules, certificate check, verifier host -> src/main/verifier/. Reads neither ctx.broker nor ctx.loader.
  signInIdentitySubsystem, // Firefox request headers on Google's sign-in hosts -> src/main/shell/sign-in-identity-headers.ts. Reads neither ctx.broker nor ctx.loader.
  // extensions -> src/main/extensions/. Listed here, before anything else
  // touches session.defaultSession (extensions/README.md's Design notes).
  // Reads neither ctx.broker nor ctx.loader.
  extensionsSubsystem,
  brokerIpcSubsystem, // build step 2: broker -> src/broker/. Writes ctx.broker -- anything reading it must be listed below this line. Reads ctx.senderAttributed -- must stay below sessionAttributionSubsystem.
  devGrantSubsystem, // queue item 0.3: dev-only grant hook -> src/main/dev-grant.ts. Reads ctx.broker -- must stay below brokerIpcSubsystem.
  requestGrantSubsystem, // queue item 4.1: app.requestGrant's mechanism -> src/main/request-grant.ts. Reads ctx.broker -- must stay below brokerIpcSubsystem.
  embedSubsystem, // ADR-0039: pages an app shows inside itself -> src/main/embed/. Reads ctx.broker -- must stay below brokerIpcSubsystem.
  childrenSubsystem, // ADR-0046: the hidden child host each app's spawn/fork/thread runs in -> src/main/children/. Reads ctx.broker -- must stay below brokerIpcSubsystem.
  // build step 3: shim      -> src/shim/
  loaderSubsystem, // build step 4: loader -> src/loader/
  appInstallSubsystem, // queue item S4-4: install-time consent -> src/main/app-install.ts. Reads ctx.broker AND ctx.loader -- must stay below both brokerIpcSubsystem and loaderSubsystem.
  // S4-2: the discovery trigger -> src/main/manifest-hint.ts. Reads BOTH
  // ctx.broker and ctx.loader, and must stay below appInstallSubsystem too:
  // it is the production caller of the install path, so ctx.installApp has
  // to be published before its first hint can arrive.
  manifestHintSubsystem,
  // build step 7: trust     -> src/trust/
  // nostr -> src/nostr/, parked: an idea, not a build step
  telemetrySubsystem, // build step 8: telemetry -> src/telemetry/
  pagesSubsystem // the shell's own pages: their scheme and session -> src/main/pages/. Reads neither ctx.broker nor ctx.loader.
]
