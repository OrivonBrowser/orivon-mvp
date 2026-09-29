import { app, BaseWindow, dialog, nativeTheme, session } from 'electron'
import { createShellWindow, resolveDashboardUrl } from './shell/window.js'
import { openUrlsOnSecondLaunch } from './shell/opener.js'
import { createShellServices } from './shell/shell-services.js'
import { SHELL_PARTITION } from './shell/shell-session.js'
import { attachExtensionShell } from './extensions/extension-host.js'
import { registerNewTabIpc } from './ipc/newtab-ipc.js'
import { applyThemeSetting } from './settings/settings-appliers.js'
import { startInternalPages } from './pages/start-internal-pages.js'
import { installShortcuts } from './shortcuts/install-shortcuts.js'
import { installZoom } from './zoom/install-zoom.js'
import { installHistory } from './history/install-history.js'
import { createSubsystemContext, criticalFailureMessage, runAfterReady, runBeforeReady, type SubsystemFailure } from './registry.js'
import { subsystems } from './subsystems.js'
import { DebouncedWriter } from './storage/debounced-writer.js'
import { devOnlySwitches } from './shell/dev-switches.js'
import { chromeUserAgent } from './shell/user-agent.js'
import { planIntro } from './shell/intro-state.js'
import { urlsFromArgv } from './launch/launch-context.js'
import { sweepPrivateDirs } from './launch/private-session.js'
import { startLaunch } from './launch/start-launch.js'
import { runUpdateCheck } from './self-update/update-check-runner.js'
import { configureVerifier } from './verifier/verifier-subsystem.js'
import type { Runtime } from './launch/start-launch.js'

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

// Every way of quitting passes here: a quit command, the last window closing
// or the system asking. The first pass holds the quit while the stores flush,
// then quits again.
let storesFlushed = false
app.on('before-quit', (event) => {
  if (storesFlushed) return
  event.preventDefault()
  void flushStoresBeforeQuit().then(() => {
    storesFlushed = true
    app.quit()
  })
})

/** A private directory a crash left is removed a while after start, when nothing else needs the disk. */
const SWEEP_DELAY_MS = 20_000

/** Starts the browser this process is. */
function boot (runtime: Runtime): void {
  const beforeReadyFailures = runBeforeReady(subsystems)
  report(beforeReadyFailures)

  // A second start of this profile asks it to show itself, and to open what it was given.
  // The ask can arrive while this one is still starting, so it waits for it.
  let opener: (urls: string[]) => void = () => {}
  let markStarted: () => void = () => {}
  const startedUp = new Promise<void>((resolve) => { markStarted = resolve })
  const requested: string[][] = []
  app.on('second-instance', (_event, argv) => {
    requested.push(urlsFromArgv(argv))
    void startedUp.then(() => { for (const urls of requested.splice(0)) opener(urls) })
  })

  // A private session ends with its last window on every platform: there is nothing to keep resident, and no window to bring back.
  app.on('window-all-closed', () => {
    if (runtime.isPrivate || process.platform !== 'darwin') app.quit()
  })

  void app.whenReady().then(async () => {
    const ctx = createSubsystemContext(app, runtime.isPrivate)
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

    const shell = createShellServices(app.getPath('userData'), ctx, runtime)
    // Wires every window's tab lifecycle into the extensions library
    // (extensionsSubsystem.afterReady already constructed it, above) and
    // hands its icon requests the chrome view's own session.
    attachExtensionShell(ctx, shell, session.fromPartition(SHELL_PARTITION))
    // Before the first window, so it opens in the chosen theme with the chosen
    // bookmarks bar rather than changing after it is on screen.
    await Promise.all([shell.settings.load(), shell.shortcutStore.load(), shell.zoomStore.load()])
    applyThemeSetting(shell.settings, nativeTheme)
    // The light client starts after the first page loads, by which time the settings have been read: the person's choice reaches it.
    configureVerifier({ lightClientEnabled: () => shell.settings.get('web3.lightClient') })
    shell.history.prune()
    startInternalPages(shell, ctx)
    shell.commands.bind({ bookmarks: shell.bookmarks, zoom: shell.zoom, devtools: shell.devtools, profiles: shell.profiles, openWindow: (options) => { createShellWindow(ctx, shell, options) }, quit: () => { app.quit() } })
    installShortcuts(app, shell.shortcuts, shell.windows, shell.commands)
    installZoom(app, shell.windows, shell.zoom)
    installHistory(app, shell.windows, shell.internalPages, shell.history)
    registerNewTabIpc(resolveDashboardUrl(), shell.windows, shell.bookmarks)
    // Looks for a newer release once a day when the person has said it may; installs nothing.
    if (!runtime.isPrivate && shell.settings.get('updates.check')) {
      void runUpdateCheck(app).catch((error) => { console.error('[orivon] the update check failed:', error) })
    }
    if (!runtime.isPrivate) {
      app.once('will-quit', () => { runtime.profiles.clearRunning(runtime.profileId) })
      setTimeout(() => { sweepPrivateDirs(); runtime.profiles.sweepDeleted() }, SWEEP_DELAY_MS).unref()
    }
    opener = (urls) => {
      openUrlsOnSecondLaunch(shell.windows.focused(), urls, (urls) => {
        createShellWindow(ctx, shell, { first: (tabs) => { for (const url of urls) tabs.createTab(url) } })
      })
    }
    markStarted()
    if (runtime.isPrivate) {
      // A private session begins with the page that says what it does, and has no welcome screen: it is the person's own second browser.
      createShellWindow(ctx, shell, { first: (tabs) => { tabs.openInternal('private') } })
    } else {
      // Only this first window can open on the welcome screen: the macOS
      // 'activate' below recreates a window in a process that has already shown it.
      createShellWindow(ctx, shell, { intro: await planIntro(process.env['ORIVON_INTRO'], app.getPath('userData')) })
      app.on('activate', () => {
        if (BaseWindow.getAllWindows().length === 0) createShellWindow(ctx, shell)
      })
    }
  })
}

// Which browser this process is, before anything reads a byte of data: another profile or a private session
// has a directory of its own, and a second start of a profile already open hands over and stops here.
const runtime = startLaunch(app, process.argv)
if (runtime !== null) boot(runtime)
