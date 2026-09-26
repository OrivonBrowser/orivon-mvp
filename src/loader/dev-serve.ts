// Developer-only surface, mirroring src/main/dev-grant.ts's own shape and
// boundary exactly: reachable ONLY from Node code already running inside
// this process (Playwright's ElectronApplication.evaluate(), the e2e
// suite's own mechanism) -- NEVER wired to window.orivon, IPC, or any
// renderer-reachable surface.
//
// WHY THIS EXISTS RATHER THAN DRIVING Loader.load() ITSELF FOR THE E2E
// TEST. install-origin.ts's ensurePublicUnicastOrigin refuses every
// non-https, non-public-unicast install origin with NO exception (A46) --
// so a loopback fixture server, the only kind an e2e suite can stand up
// hermetically, can NEVER complete a real load(). That check belongs to
// the FETCH half of this directory (fetch/bundle.ts) and has nothing to do
// with the SERVE half this lane builds -- serving reads back whatever is
// already validly pinned on disk, regardless of how it got there. This
// hook exposes exactly that seam: given an origin the test has already
// written a real, valid pin and its assets for (via node-storage.ts's own
// functions, called directly from the test process -- see
// test/e2e-serve-from-cache.test.ts), register its serving for real.
//
// GATED BEHIND THE SAME __ORIVON_DEV_GRANT_ENABLED__ FLAG dev-grant.ts
// declares, not a second one -- both are e2e-build-only conveniences
// enabled by the identical `ORIVON_ENABLE_DEV_GRANT=1` build
// (scripts/build-e2e.mjs), and a second flag would need a second `define`
// wired through electron.vite.config.ts, a file outside src/loader/
// (parallel-work.md's ownership map).

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const DEV_SERVE_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

// `var`, not `let`/`const`: TypeScript requires it for a `declare global`
// augmentation (dev-grant.ts's identical declaration carries the same note).
declare global {
  var __orivonDevRegisterServing: ((origin: string) => Promise<void>) | undefined
}

/** Installs the hook, closing over the real `registerServingFor` call the caller (subsystem.ts) already has bound to its one real LoaderStorage -- never a second instance built for convenience. */
export function installDevServeHook (registerServingFor: (origin: string) => Promise<void>): void {
  globalThis.__orivonDevRegisterServing = registerServingFor
}

/** Whether the hook should be installed, given the compiled-in flag -- split out so it is testable without faking a build-time define (mirrors dev-grant.ts's `shouldInstallDevGrant`). */
export function shouldInstallDevServe (flag: boolean | undefined): boolean {
  return flag === true
}

/** The one call site: `subsystem.ts`'s `afterReady`, right after `storage` is constructed. */
export function maybeInstallDevServeHook (registerServingFor: (origin: string) => Promise<void>): void {
  if (shouldInstallDevServe(DEV_SERVE_ENABLED)) installDevServeHook(registerServingFor)
}
