// Developer-only grant path (docs/planning/unattended-build-queue.md item
// 0.3). Reachable ONLY from Node code already running inside this process --
// e.g. Playwright's ElectronApplication.evaluate(), which the e2e suite uses
// instead of calling the broker's own grant()/registerApp() directly from
// test code. NEVER wired to window.orivon, IPC or any renderer-reachable
// surface: an untrusted page must never be one bug away from granting
// itself a capability -- see this file's own tests for the boundary that
// protects.
//
// Compiled out of an ordinary build: electron.vite.config.ts folds
// __ORIVON_DEV_GRANT_ENABLED__ to a literal `false` unless
// ORIVON_ENABLE_DEV_GRANT=1 was set at build time (scripts/build-e2e.mjs is
// the only caller that sets it), which lets the minifier remove this file's
// own contents from the compiled output entirely --
// scripts/check-dev-grant-absent.mjs proves that against the real build
// rather than assuming it.

import type { SubsystemContext, Subsystem } from './registry.js'
import type { Broker } from '../broker/broker-contracts.js'
import type { CapabilityKind, Grant, Manifest, Pattern } from '../contracts/index.js'

/**
 * Folded to a literal boolean by electron.vite.config.ts's `define` inside a
 * real build. Left undeclared under plain `vitest` (that config never
 * runs there), which is fine: `typeof` on an undeclared identifier reads
 * 'undefined' rather than throwing, so DEV_GRANT_ENABLED below is always
 * `false` under a unit test -- this file's tests exercise the pieces that
 * decision calls into directly instead.
 */
declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const DEV_GRANT_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

/** One call the dev-only hook accepts: register `origin`'s manifest, then grant it one capability. */
export interface DevGrantRequest {
  readonly origin: string
  readonly manifest: Manifest
  readonly capability: CapabilityKind
  readonly patterns: readonly Pattern[]
}

declare global {
  // `var`, not `let`/`const`: TypeScript requires it for a `declare global`
  // augmentation. Undefined except inside a process this hook was installed
  // in -- see installDevGrantHook.
  var __orivonDevGrant: ((request: DevGrantRequest) => Promise<Grant>) | undefined
}

/**
 * Installs the hook on `globalThis`, reachable only by code with direct
 * access to this Node process's global scope -- not by any IPC channel, not
 * by any preload, not by window.orivon. `registerApp` is safe to call again
 * for an origin already registered (GrantLedger.registerApp replaces the
 * prior manifest); a dev/test caller owns the whole lifetime of the app it
 * is driving, so that is the right behaviour here, not a workaround.
 */
export function installDevGrantHook (broker: Broker): void {
  globalThis.__orivonDevGrant = async (request) => {
    await broker.registerApp(request.origin, request.manifest)
    return await broker.grant(request.origin, request.capability, request.patterns)
  }
}

/** Whether the hook should be installed, given the compiled-in flag. Split out so it is testable without faking a build-time define. */
export function shouldInstallDevGrant (flag: boolean | undefined): boolean {
  return flag === true
}

/**
 * Registered UNCONDITIONALLY in subsystems.ts -- the append point may carry
 * no logic (that file's own header). The conditional lives here instead,
 * and collapses to a no-op afterReady in any build that did not set
 * ORIVON_ENABLE_DEV_GRANT, which is every build except npm run test:e2e's.
 * Not marked `critical`: a broken dev-only path must never take the real
 * browser down.
 */
export const devGrantSubsystem: Subsystem = {
  name: 'dev-grant',
  afterReady: (ctx: SubsystemContext) => {
    if (!shouldInstallDevGrant(DEV_GRANT_ENABLED)) return
    if (ctx.broker === undefined) {
      throw new Error('dev-grant subsystem requires ctx.broker -- check its position in subsystems.ts')
    }
    installDevGrantHook(ctx.broker)
  }
}
