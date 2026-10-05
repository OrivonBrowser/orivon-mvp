// Test builds only: exposes installFromFolder/installFromFile on
// `globalThis`, reachable from Playwright's ElectronApplication.evaluate()
// -- store-test-hook.ts's own header has the full reasoning (this is the
// same seam for the same reason: no real native file/folder picker exists
// for a headless e2e run to click through). A caller still goes through the
// real finishInstall path (install-runner.ts), consent prompt included --
// an e2e test answers the question in the panel (test/support/question-support.ts)
// rather than this hook skipping it, so the install path under test is the
// same one a person's own "Add extension" click runs.
// Gated on the same compiled-in flag as the developer grant, so an ordinary
// build carries none of it; scripts/check-dev-grant-absent.mjs proves that
// by looking for __orivonDevExtensionsInstall in the output.
import type { InstallOutcome } from './install-runner.js'

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

export interface ExtensionsInstallTestHook {
  readonly installFromFolder: (dir: string) => Promise<InstallOutcome>
  readonly installFromFile: (filePath: string) => Promise<InstallOutcome>
}

declare global {
  // `var`, not `let`/`const`: TypeScript requires it for a `declare global`
  // augmentation. Undefined except inside a process this hook was installed
  // in -- see installExtensionsInstallTestHook.
  var __orivonDevExtensionsInstall: ExtensionsInstallTestHook | undefined
}

/** Reachable only by code with direct access to this Node process's global
 * scope -- not by any IPC channel, not by any preload, not by
 * window.orivon. */
export function installExtensionsInstallTestHook (hook: ExtensionsInstallTestHook): void {
  if (!SEAM_ENABLED) return
  globalThis.__orivonDevExtensionsInstall = hook
}
