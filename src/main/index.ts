import { app, BaseWindow, dialog } from 'electron'
import { createShellWindow } from './window.js'
import { createSubsystemContext, criticalFailureMessage, runAfterReady, runBeforeReady, type SubsystemFailure } from './registry.js'
import { subsystems } from './subsystems.js'

// Main and preload are CommonJS; only the renderer is ESM. This is
// electron-vite's default and it is kept deliberately, for one reason:
// sandboxed preload scripts have no ESM context at all -- they run as plain
// JavaScript and load electron via require. `sandbox: true` is non-negotiable
// here, so the preload must be CJS, and matching main to it avoids a
// two-format build for no gain.
//
// For the record, because it would otherwise be assumed: an ESM main process
// works fine. `import { app, ... } from 'electron'` was verified against
// Electron 44 on 2026-08-25 and returns the real API. If a future need for
// ESM in main appears, nothing here blocks it.
//
// BrowserWindow -> BaseWindow (build step 1, 2026-08-26): confirmed via
// live docs that BrowserWindow supports only a single full-size web view,
// while BaseWindow composes many (window-customization.md) -- required for
// the shell's chrome view + tab views. The webPreferences load-bearing note
// below now lives in window.ts and tabs.ts, next to where each view is
// actually constructed; still true, still worth reading there.
//
// A hookify rule rejects edits that weaken contextIsolation/sandbox/
// nodeIntegration/webSecurity anywhere in this tree (security-model.md T17
// and the block-insecure-webpreferences rule).

// TRIED AND REVERTED 2026-08-26, same session: forcing
// `ozone-platform: x11` was tried here on a since-corrected diagnosis (a
// report of "no window ever appears" was first misread as the window
// opening on the wrong monitor, chased partway down a Wayland-can't-
// control-window-position path). It made things strictly worse: the GPU
// process segfaulted under XWayland on this machine (`exit_code=139`)
// and the window stopped rendering at all. Reverted immediately. The
// real bug was never about display selection -- see window.ts's
// `showOnce` comment for the actual root cause and fix
// (`ready-to-show` unreliable when loading from the dev server). Do not
// re-add this switch without a real reason and without first solving
// the GPU crash it causes here.

// Subsystems register here rather than editing this file -- see registry.ts
// and src/main/subsystems.ts. This is the only wiring code; adding a broker,
// shim or telemetry subsystem touches subsystems.ts and nothing else.
function report (failures: SubsystemFailure[]): void {
  // Loud, never silent. A subsystem that failed to start may be a capability
  // that is now enforcing nothing, and handle-contracts.md SSWhat the shim
  // must do (rule 2) makes it binding that error visibility in
  // security-relevant code is HIGHER than the default, not lower.
  for (const { name, phase, error } of failures) {
    console.error(`[orivon] subsystem "${name}" failed during ${phase}:`, error)
  }
}

const beforeReadyFailures = runBeforeReady(subsystems)
report(beforeReadyFailures)

void app.whenReady().then(async () => {
  const ctx = createSubsystemContext(app)
  const afterReadyFailures = await runAfterReady(subsystems, ctx)
  report(afterReadyFailures)

  // A CRITICAL subsystem failing (today: only the broker) means the
  // capability layer is dark -- opening a normal-looking shell window in
  // that state is strictly worse than not opening one at all: every
  // orivon.* call from every app would be silently unroutable, with only a
  // main-process console line as evidence. Fail loud instead of booting a
  // browser that only looks like it works (open-questions.md A51).
  const fatal = criticalFailureMessage([...beforeReadyFailures, ...afterReadyFailures])
  if (fatal !== null) {
    dialog.showErrorBox('Orivon failed to start', fatal)
    app.exit(1)
    return
  }

  createShellWindow()
  app.on('activate', () => {
    if (BaseWindow.getAllWindows().length === 0) createShellWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
