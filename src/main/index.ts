import { app, BaseWindow, dialog } from 'electron'
import { createShellWindow } from './window.js'
import { createSubsystemContext, criticalFailureMessage, runAfterReady, runBeforeReady, type SubsystemFailure } from './registry.js'
import { subsystems } from './subsystems.js'
import { BookmarkStore } from './bookmarks.js'

// Do not add `ozone-platform: x11` here without solving its GPU crash on
// this machine first -- the window-visibility bug it was chasing is really
// window.ts's `showOnce` (README.md, Design notes).

// Owner's decision, 2026-09-09: an uncaught main-process error is LOGGED and
// exits. Electron's default is a modal error dialog, and a modal dialog keeps
// its process alive until a human clicks it -- so on an unattended run every
// crash became a window left on the developer's screen and an Electron
// process tree that never exited, accumulating overnight. Registered here,
// above every other statement, because a throw before this line still gets
// the dialog.
//
// This moves where a crash is REPORTED, and hides nothing: the error is
// printed in full and the non-zero exit is what a test runner reads.
function exitOnUncaught (kind: string, error: unknown): void {
  console.error(`[orivon] ${kind} in the main process:`, error)
  app.exit(1)
}

process.on('uncaughtException', (error) => { exitOnUncaught('uncaught exception', error) })
process.on('unhandledRejection', (reason) => { exitOnUncaught('unhandled promise rejection', reason) })

// Subsystems register in subsystems.ts (the append point), never here.
function report (failures: SubsystemFailure[]): void {
  // Loud, never silent. A subsystem that failed to start may be a capability
  // that is now enforcing nothing, and handle-contracts.md's "What the shim
  // must do" section (rule 2) makes it binding that error visibility in
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

  createShellWindow(ctx)
  app.on('activate', () => {
    if (BaseWindow.getAllWindows().length === 0) createShellWindow(ctx)
  })
})

// A bookmark starred within the debounce window of the browser closing must
// not be silently lost -- that is precisely the failure BookmarkStore's
// flushPendingWrite() exists to prevent, so quit needs to wait for it.
// Bounded, not indefinite: BookmarkStore.flushAll() itself never rejects
// (a slow or failed store is reported via console.error in bookmarks.ts and
// does not stop the others), and the race below caps the wait so a stuck
// disk turns into a bookmark loss on that one store rather than a browser
// that will not close. The bound is generous relative to the 300ms debounce
// (WRITE_DEBOUNCE_MS) plus ordinary disk latency, and short enough that a
// user closing the window does not perceive a hang.
const QUIT_FLUSH_TIMEOUT_MS = 2000

async function flushBookmarksBeforeQuit (): Promise<void> {
  await Promise.race([
    BookmarkStore.flushAll(),
    new Promise<void>((resolve) => setTimeout(resolve, QUIT_FLUSH_TIMEOUT_MS))
  ])
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') void flushBookmarksBeforeQuit().then(() => app.quit())
})
