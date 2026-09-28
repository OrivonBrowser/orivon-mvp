import { app, BaseWindow, dialog, nativeTheme } from 'electron'
import { createShellWindow, resolveDashboardUrl } from './shell/window.js'
import { createShellServices } from './shell/shell-services.js'
import { registerNewTabIpc } from './ipc/newtab-ipc.js'
import { applyThemeSetting } from './settings/settings-appliers.js'
import { createSubsystemContext, criticalFailureMessage, runAfterReady, runBeforeReady, type SubsystemFailure } from './registry.js'
import { subsystems } from './subsystems.js'
import { DebouncedWriter } from './storage/debounced-writer.js'
import { devOnlySwitches } from './shell/dev-switches.js'
import { chromeUserAgent } from './shell/user-agent.js'
import { planIntro } from './shell/intro-state.js'

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

// Before any subsystem runs: Electron applies this fallback reliably only when
// it is set ahead of the first session. Its own default carries `Electron/`
// and `orivon/` tokens, which is-electron checks and sign-in pages refuse.
app.userAgentFallback = chromeUserAgent(process.versions.chrome, process.platform)

// Command-line switches apply only if set before app.whenReady(), same as
// verifierSubsystem's own beforeReady -- this one is not `.eth`-specific
// (dev-switches.ts), so it lives here rather than there.
for (const flag of devOnlySwitches()) app.commandLine.appendSwitch(flag)

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

  // Only this first window can open on the welcome screen: the macOS
  // 'activate' below recreates a window in a process that has already shown it.
  const shell = createShellServices(app.getPath('userData'))
  // Before the first window, so it opens in the chosen theme with the chosen
  // bookmarks bar rather than changing after it is on screen.
  await shell.settings.load()
  applyThemeSetting(shell.settings, nativeTheme)
  registerNewTabIpc(resolveDashboardUrl(), shell.windows, shell.bookmarks)
  createShellWindow(ctx, shell, await planIntro(process.env['ORIVON_INTRO'], app.getPath('userData')))
  app.on('activate', () => {
    if (BaseWindow.getAllWindows().length === 0) createShellWindow(ctx, shell)
  })
})

// A change made within the debounce window of the browser closing (a starred
// page, a setting) must not be silently lost -- that is precisely what
// DebouncedWriter.flushAll() exists to prevent, so quit waits for it.
// Bounded, not indefinite: flushAll() itself never rejects (a slow or failed
// store reports its own failure), and the race below caps the wait so a stuck
// disk turns into a lost change in that one store rather than a browser that
// will not close. The bound is generous relative to the 300ms debounce
// (WRITE_DEBOUNCE_MS) plus ordinary disk latency, and short enough that a
// user closing the window does not perceive a hang.
const QUIT_FLUSH_TIMEOUT_MS = 2000

async function flushStoresBeforeQuit (): Promise<void> {
  await Promise.race([
    DebouncedWriter.flushAll(),
    new Promise<void>((resolve) => setTimeout(resolve, QUIT_FLUSH_TIMEOUT_MS))
  ])
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') void flushStoresBeforeQuit().then(() => app.quit())
})
