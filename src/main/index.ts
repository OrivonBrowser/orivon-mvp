import { app, BaseWindow, dialog, nativeTheme, screen, session } from 'electron'
import { createShellWindow, resolveDashboardUrl } from './shell/window.js'
import { fileProtocolFuse } from './local-files/file-fuse.js'
import { answerLaunch } from './shell/opener.js'
import { createShellServices } from './shell/shell-services.js'
import { runShellInstallers } from './shell/shell-installers.js'
import { askQuestion } from './shell/question/ask-question.js'
import { SHELL_PARTITION } from './shell/shell-session.js'
import { attachExtensionShell } from './extensions/extension-host.js'
import { registerNewTabIpc } from './ipc/newtab-ipc.js'
import { applyThemeSetting } from './settings/settings-appliers.js'
import { startInternalPages } from './pages/start-internal-pages.js'
import { installShortcuts } from './shortcuts/install-shortcuts.js'
import { installSpellcheck } from './spellcheck/install-spellcheck.js'
import { installZoom } from './zoom/install-zoom.js'
import { installShellStyle } from './appearance/shell-style-runner.js'
import { internalSession } from './pages/internal-session.js'
import { installHistory } from './history/install-history.js'
import { installDownloads } from './downloads/install-downloads.js'
import { installDownloadsPeek } from './downloads/auto-open.js'
import { createSubsystemContext, criticalFailureMessage, publishOpenTabs, publishScoreVerdictFor, publishShowNotice, publishWebsiteScore, publishWindowForSender, runAfterReady, runBeforeReady, type SubsystemFailure } from './registry.js'
import { subsystems } from './subsystems.js'
import { DebouncedWriter } from './storage/debounced-writer.js'
import { devOnlySwitches } from './shell/dev-switches.js'
import { chromeUserAgent } from './shell/user-agent.js'
import { planIntro } from './shell/intro-state.js'
import { setTelemetryOn, welcomeOffersTelemetry } from '../telemetry/runner.js'
import { firstWindowOptions } from './shell/first-window.js'
import { seedClosedStack } from './session-restore/restore.js'
import { atStartup, readLaunchRequest } from './launch/launch-request.js'
import type { LaunchRequest } from './launch/launch-request.js'
import { canOfferDefault } from './os/default-browser.js'
import { defaultBrowserHost } from './os/default-browser-runner.js'
import { handleOpenUrl } from './os/open-url.js'
import { handleOpenFile } from './os/open-file.js'
import { removeAfterExit, removePrivateDir, sweepPrivateDirs } from './launch/private-session.js'
import { loadFetchStack } from './startup/fetch-stack.js'
import { runUpdateCheck } from './self-update/update-check-runner.js'
import { scheduleUpdateChecks } from './self-update/update-schedule.js'
import { configureVerifier, verifierEthContentCid } from './verifier/verifier-subsystem.js'
import { createPageScoreLookup } from './browsing/page-score-lookup.js'
import { netFetchJson } from './browsing/score-provider-client.js'
import { isDevEthName } from './dev/eth-resolver.js'
import { isOriginServedFromCacheSync } from '../loader/electron/serve.js'
import type { Runtime } from './launch/start-launch.js'

// Do not add `ozone-platform: x11` here without solving its GPU crash on
// this machine first -- the window-visibility bug it was chasing is really
// window.ts's `showOnce` (README.md, Design notes).

// Before any subsystem or hook exists (startup/fetch-stack.ts says why).
loadFetchStack()

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

/** `web-contents-created` takes a listener from each installer; past Node's default of ten it warns of a leak that is not one. */
const APP_LISTENER_ROOM = 24

/** Starts the browser this process is. */
export function boot (runtime: Runtime): void {
  app.setMaxListeners(Math.max(app.getMaxListeners(), APP_LISTENER_ROOM))
  const beforeReadyFailures = runBeforeReady(subsystems)
  report(beforeReadyFailures)

  // A second start of this profile asks it to show itself, to open a window or a private session, and to open what it was given.
  // The ask can arrive while this one is still starting, so it waits for it. A private session takes no lock, so no second start reaches it.
  let opener: (request: LaunchRequest) => void = () => {}
  let markStarted: () => void = () => {}
  let started = false
  const startedUp = new Promise<void>((resolve) => { markStarted = () => { started = true; resolve() } })
  const requested: LaunchRequest[] = []
  const queueLaunch = (request: LaunchRequest): void => {
    requested.push(started ? request : atStartup(request))
    void startedUp.then(() => { for (const waiting of requested.splice(0)) opener(waiting) })
  }
  // A private session nobody started from another browser removes its own directory once its process is gone: Chromium
  // writes more as it quits, so a removal from inside would be undone. The sweep at a later start removes what is left.
  const madeDir = runtime.madeDir
  if (madeDir !== undefined) process.once('exit', () => { if (!removeAfterExit(madeDir, process.pid)) removePrivateDir(madeDir) })
  if (!runtime.isPrivate) {
    app.on('second-instance', (_event, argv, _workingDirectory, data) => { queueLaunch(readLaunchRequest(data, argv)) })
    // macOS hands a clicked link to the running app as an event; it joins the same queue.
    app.on('open-url', (event, url) => { handleOpenUrl(event, url, (urls) => { queueLaunch({ kind: 'open', urls }) }) })
    // A document the system hands to the browser (the file manager's Open with, a drop on the dock icon) opens as the command line's would.
    app.on('open-file', (event, path) => { handleOpenFile(event, path, (urls) => { queueLaunch({ kind: 'open', urls }) }) })
  }

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

    const shell = createShellServices(app.getPath('userData'), runtime, ctx)
    // Wires every window's tab lifecycle into the extensions library
    // (extensionsSubsystem.afterReady already constructed it, above) and
    // hands its icon requests the chrome view's own session.
    attachExtensionShell(ctx, shell, session.fromPartition(SHELL_PARTITION))
    // Published here, not by a subsystem: every subsystem's afterReady ran
    // during runAfterReady above, before shell.windows existed to answer
    // this at all (registry.ts's own doc on ctx.windowForSender). A consent
    // dialog resolves this LAZILY, well after this line runs, so publishing
    // it late is safe -- see requestGrantSubsystem.ts and manifest-hint.ts
    // for the thunks that read ctx.windowForSender only when a real dialog
    // is about to show one.
    publishWindowForSender(ctx, (sender) => shell.windows.findTab(sender)?.window.window)
    // The same lateness: the app-update offers look at open tabs and ask the chosen Web3 Score provider.
    publishOpenTabs(ctx, { on: (origin) => shell.windows.liveTabsOn(origin), origins: () => shell.windows.liveTabOrigins() })
    publishScoreVerdictFor(ctx, shell.scoreProvider.verdictFor)
    // Read lazily by the control channel, which was wired before the settings it reads existed (ADR-0058).
    publishWebsiteScore(ctx, createPageScoreLookup({
      providerAddress: () => shell.settings.get('web3.scoreProvider'),
      isDevEthName,
      fetchJson: netFetchJson,
      resolveEthContent: verifierEthContentCid,
      manifestAt: async (origin, cid) => await ctx.loader?.manifestAt(origin, cid) ?? { kind: 'unread', reason: 'the loader is not running' }
    }).websiteScore)
    // A refusal the person should read, drawn in the window they are using.
    publishShowNotice(ctx, ({ title, message }) => { void askQuestion({}, { kind: 'notice', title, message, buttons: ['OK'], cancelId: 0 }) })
    // Before the first window, so it opens in the chosen theme with the chosen
    // bookmarks bar rather than changing after it is on screen, and so a page
    // starred in the first moments is added to the bookmarks on disk, not to an
    // empty tree the file then replaces.
    await Promise.all([shell.settings.load(), shell.searchEngines.load(), shell.shortcutStore.load(), shell.windowState.load(), shell.zoomStore.load(), shell.session.load(), shell.bookmarks.load()])
    const seeded = seedClosedStack(shell.closedTabs, shell.session.previous())
    // The windows of a run that crashed stay in the session file while they wait on the stack to be restored.
    if (shell.session.previous()?.clean === false) {
      shell.session.carry(() => shell.closedTabs.list().flatMap((entry) => entry.kind === 'window' && seeded.includes(entry.id) ? [entry.window] : []))
    }
    applyThemeSetting(shell.settings, nativeTheme)
    // The host starts only when a .eth address is needed, by which time the settings have been read: the person's choice reaches it.
    configureVerifier({ lightClientEnabled: () => shell.settings.get('web3.lightClient'), windows: () => shell.windows.all(), servedFromCache: isOriginServedFromCacheSync })
    shell.history.prune()
    startInternalPages(shell, ctx)
    // Another profile's own process can rename, add, remove or start one --
    // profiles-watcher.ts's own header on why this is the one store the
    // filesystem itself has to announce.
    shell.profiles.startWatching()
    app.once('will-quit', () => { shell.profiles.stopWatching() })
    shell.commands.bind({ services: shell, openWindow: (options) => { createShellWindow(ctx, shell, options) }, displays: () => screen.getAllDisplays(), quit: () => { app.quit() } })
    installShortcuts(app, shell.shortcuts, shell.windows, shell.commands, ctx.extensions?.commandKeys)
    installZoom(app, shell.windows, shell.zoom)
    installShellStyle(app, shell.settings, { shellSession: session.fromPartition(SHELL_PARTITION), internalSession, dashboardUrl: resolveDashboardUrl() })
    installSpellcheck(app, shell.windows, shell.settings)
    installHistory(app, shell.windows, shell.internalPages, shell.history)
    runShellInstallers(app, shell, ctx, runtime)
    installDownloads(app, { windows: shell.windows, downloads: shell.downloads, defaultSession: session.defaultSession, discardHeldAtQuit: runtime.isPrivate })
    installDownloadsPeek(shell)
    registerNewTabIpc(resolveDashboardUrl(), shell.windows, shell.bookmarks)
    // Looks for a newer release once a day when the person has said it may, from the moment they say so; installs nothing.
    if (!runtime.isPrivate) {
      const stopUpdateChecks = scheduleUpdateChecks({
        enabled: () => shell.settings.get('updates.check'),
        onEnabledChange: (listener) => shell.settings.onChange((change) => { if (change.key === 'updates.check') listener() }),
        run: async () => { await runUpdateCheck(app).catch((error: unknown) => { console.error('[orivon] the update check failed:', error) }) }
      })
      app.once('will-quit', stopUpdateChecks)
    }
    if (!runtime.isPrivate) {
      app.once('will-quit', () => { runtime.profiles.clearRunning(runtime.profileId) })
      setTimeout(() => { sweepPrivateDirs(); runtime.profiles.sweepDeleted() }, SWEEP_DELAY_MS).unref()
    }
    opener = (request) => {
      answerLaunch(request, shell.windows.focused(), {
        create: (options) => { createShellWindow(ctx, shell, options) },
        openPrivate: (urls) => shell.profiles.openPrivate(urls),
        kiosk: shell.kiosk
      })
    }
    // Marked started only once the first window exists, never before: a
    // second launch arriving in the gap while this one is still choosing its
    // first window's options (planIntro's await, below) would otherwise run
    // the opener with no window open, creating one of its own -- two windows
    // for one launch. The `finally` marks it started even if that throws,
    // so a startup failure (already fatal via start.ts's unhandledRejection handler)
    // does not also strand every second launch queued behind it.
    if (runtime.isPrivate) {
      try {
        // A private session begins with the page that says what it does, and has no welcome screen: it is the person's own second browser.
        // firstOfLaunch: true -- the ONLY createShellWindow call ORIVON_WINDOW_NO_FOCUS=1 may leave
        // unfocused (window-options.ts's own doc); every other window this process opens always takes focus.
        const plan = firstWindowOptions({ services: shell, isPrivate: true, argv: process.argv, packaged: app.isPackaged })
        if (plan.localFiles === true) await fileProtocolFuse()
        createShellWindow(ctx, shell, { ...plan, first: plan.first ?? ((tabs) => { tabs.openInternal('private') }), firstOfLaunch: true })
      } finally {
        markStarted()
      }
    } else {
      let afterFirst: (() => void) | undefined
      try {
        // Only this first window can open on the welcome screen: the macOS
        // 'activate' below recreates a window in a process that has already shown it.
        // Only the default profile's own screen offers it, and a kiosk is no one's browser.
        const offersDefault = runtime.profileId === 'default' && !shell.kiosk && canOfferDefault(defaultBrowserHost)
        const plan = firstWindowOptions({ services: shell, isPrivate: false, argv: process.argv, packaged: app.isPackaged, displays: screen.getAllDisplays(), openWindow: (options) => { createShellWindow(ctx, shell, options) } })
        // A first tab that is a local file needs the binary's fuse read, which nothing else at start-up does.
        if (plan.localFiles === true) await fileProtocolFuse()
        const firstWindow = createShellWindow(ctx, shell, { ...plan, intro: plan.intro ?? await planIntro(process.env['ORIVON_INTRO'], app.getPath('userData'), offersDefault, { offered: welcomeOffersTelemetry, choose: async (on) => { await setTelemetryOn(on, 'welcome') } }), firstOfLaunch: true })
        const after = plan.after
        afterFirst = after === undefined ? undefined : () => { after(firstWindow) }
      } finally {
        markStarted()
      }
      // The rest of a restored session, once the first window exists and a second launch may be answered.
      try { afterFirst?.() } catch (error) { console.error('[orivon] restoring the other windows failed:', error) }
      app.on('activate', () => {
        if (BaseWindow.getAllWindows().length === 0) createShellWindow(ctx, shell)
      })
    }
  })
}
