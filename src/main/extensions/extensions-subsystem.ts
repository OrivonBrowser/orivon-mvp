// Registers extensions on `afterReady`: constructs the electron-chrome-
// extensions library (ADR-0043) on session.defaultSession, then loads every
// enabled registry entry into it, then publishes install/uninstall/enable/
// list to `ctx.extensions`. Listed after `verifierSubsystem` in
// `../subsystems.ts` -- README.md's Design notes say why. The library must
// exist BEFORE the first loadExtension() call, so its own 'extension-loaded'
// listener sees every extension (extension-host.ts's own header).

import { join } from 'node:path'
import { session, webContents } from 'electron'
import type { Subsystem, SubsystemContext } from '../registry.js'
import { publishExtensions } from '../registry.js'
import { readRegistry } from './registry-runner.js'
import { installFromFile, installFromFolder, type InstallContext, type InstallOutcome, type InstallWhere } from './install-runner.js'
import { setEnabled, uninstall } from './install-lifecycle.js'
import { createExtensionInstallPrompt } from './extension-install-prompt.js'
import { clearChromeStorage } from './extension-storage-clear.js'
import { createExtensionHost, extensionPagesAroundReload } from './extension-host.js'
import { installExtensionPermissionWarningFilter } from './extension-known-permissions.js'
import { startWebStore, type StoreApi } from './store-runner.js'
import { PRIVATE_INSTALL_REASON } from './install-private.js'
import { installStoreTestHook } from './store-test-hook.js'
import { installExtensionsInstallTestHook } from './extensions-install-test-hook.js'
import type { InstalledExtension } from './registry.js'
import type { ExtensionPrefsStore } from './extension-prefs.js'
import { createExtensionPrefsStore, prefsFilePath } from './extension-prefs-runner.js'
import { createManifestApplier, type ApplyMode, type ApplyResult } from './effective-manifest-runner.js'
import { extensionPageOpen } from './extension-page-open.js'
import { attachExtensionsDnr, getDnrEngine } from './extensions-dnr.js'
import { registerDnrApiHandlers } from './dnr-api.js'
import { installApis } from './api/install-apis.js'
import { provideCommandKeys } from './api/commands-api.js'
import { installExtensionCommands } from './install-extension-commands.js'
import type { ExtensionCommandKeys } from './extension-commands-runner.js'
import { installDnrWebRequestHandlers } from './dnr-webrequest.js'

export interface ExtensionsApi {
  readonly installFromFolder: (dir: string, where?: InstallWhere) => Promise<InstallOutcome>
  readonly installFromFile: (filePath: string, where?: InstallWhere) => Promise<InstallOutcome>
  readonly uninstall: (id: string) => Promise<void>
  readonly setEnabled: (id: string, enabled: boolean) => Promise<void>
  readonly list: () => readonly InstalledExtension[]
  /** Downloads, verifies (requiring both the developer's and the Chrome Web
   * Store's own proof) and installs `id` from the store -- the real flow's
   * entry point is `chrome.webstorePrivate.beginInstallWithManifest3` on
   * chromewebstore.google.com's own page (store-runner.ts's `host.installCrx`),
   * reached through the vendored preload; this is also what
   * store-test-hook.ts exposes for an e2e build with no real store page to
   * drive it from. */
  readonly installFromStore: (id: string) => Promise<InstallOutcome>
  /** Checks every store-managed extension for an update now, instead of
   * waiting for the vendored updater's own start/5-hour cadence. */
  readonly checkForUpdates: () => Promise<void>
  /** Installs an update a check held back for consent (registry.ts's
   * `ExtensionUpdater.pendingUpdate`), prompting first. */
  readonly updateFromStore: (id: string) => Promise<InstallOutcome>
  /** What the person chose per extension (pins, grants, site access, shortcuts, overrides). */
  readonly prefs: ExtensionPrefsStore
  /** The keys of the commands extensions declare: what the shortcut dispatcher runs and the shortcuts page lists. */
  readonly commandKeys: ExtensionCommandKeys
  /** Rewrites the extension's loaded manifest from its base and `prefs`, then reloads it:
   * at once for 'now', once no page of it is open for 'quiet'. */
  readonly applyManifest: (id: string, mode: ApplyMode) => Promise<ApplyResult>
}

/**
 * Loads every ENABLED entry from `userDataPath`'s registry into
 * `session.defaultSession`. Electron remembers no extension across restarts
 * (registry.ts's own header), so this replays the whole registry at every
 * boot. A single entry's load failure marks nothing, logs the error, and
 * the rest still load -- one damaged install must not strand every other
 * extension unloaded.
 */
async function loadEnabledExtensions (userDataPath: string): Promise<void> {
  for (const entry of readRegistry(userDataPath)) {
    if (!entry.enabled) continue
    try {
      // Never allowFileAccess: true -- extensions never get file:// access
      // (README.md's Design notes).
      await session.defaultSession.extensions.loadExtension(entry.path, { allowFileAccess: false })
    } catch (error) {
      console.error(`[extensions] failed to load ${entry.id} (${entry.name}) from ${entry.path}: ${String(error)}`)
    }
  }
}

const refusingStore: StoreApi = {
  installFromStore: async () => ({ installed: false, reason: PRIVATE_INSTALL_REASON }),
  checkForUpdates: async () => {},
  updateFromStore: async () => ({ installed: false, reason: PRIVATE_INSTALL_REASON })
}

export const extensionsSubsystem: Subsystem = {
  name: 'extensions',
  afterReady: async (ctx: SubsystemContext) => {
    // Before the first loadExtension() below (and before install-runner.ts's
    // later ones): extension-known-permissions.ts's own doc says why.
    installExtensionPermissionWarningFilter()

    // ONE '../', not two: main is bundled into a single out/main/index.js
    // (electron.vite.config.ts), so import.meta.dirname is out/main/ for
    // every file's code regardless of its original src/ nesting -- the same
    // reason tabs.ts's own join(import.meta.dirname, '../preload/app.js')
    // has one, not the two its src/main/shell/ nesting might suggest.
    const hostExtensions = createExtensionHost(join(import.meta.dirname, '../preload/extension-api.js'))

    const userDataPath = ctx.app.getPath('userData')

    // Must attach before loadEnabledExtensions() below fires its first
    // 'extension-loaded' (extensions-dnr.ts's own header says why), and the
    // router/webRequest wiring may as well go right alongside it: nothing
    // reaches either before the first extension loads regardless.
    attachExtensionsDnr(session.defaultSession, userDataPath)
    const { onRuleMatched, onTabNavigated } = registerDnrApiHandlers(hostExtensions.getRouter(), hostExtensions, userDataPath, {
      exists: (tabId) => { const tab = webContents.fromId(tabId); return tab != null && !tab.isDestroyed() },
      whenClosed: (tabId, run) => { webContents.fromId(tabId)?.once('destroyed', run) }
    })
    installDnrWebRequestHandlers(session.defaultSession, getDnrEngine, onRuleMatched, onTabNavigated)

    const prefs = createExtensionPrefsStore(ctx.privateSession ? null : prefsFilePath(userDataPath))
    const manifests = createManifestApplier({ userDataPath, session: session.defaultSession, prefs, isOpen: extensionPageOpen, pages: extensionPagesAroundReload })
    if (!ctx.privateSession) manifests.applyAtBoot()
    installApis({ host: hostExtensions, session: session.defaultSession, userDataPath, ctx, prefs })
    const commandKeys = installExtensionCommands({ ctx, prefs, userDataPath })
    provideCommandKeys(commandKeys)

    // A private or guest runtime runs no extension: nothing loads and every
    // install route refuses; the store page's hook still starts (below).
    if (!ctx.privateSession) await loadEnabledExtensions(userDataPath)

    const install: InstallContext = { userDataPath, session: session.defaultSession, prompt: createExtensionInstallPrompt(), prefs, privateSession: ctx.privateSession, clearExtensionStorage: async (id) => { await clearChromeStorage(session.defaultSession, id) } }
    const preloadPath = join(import.meta.dirname, '../preload/web-store.js')
    // Started in every runtime: a store tab in a private window must never reach the native
    // `chrome.webstorePrivate`. In a private one installs are denied inside it.
    const started = await startWebStore(install, preloadPath)
    const store = ctx.privateSession ? refusingStore : started
    installStoreTestHook(store)
    const extensionsApi: ExtensionsApi = {
      installFromFolder: async (dir, where) => await installFromFolder(install, dir, where),
      installFromFile: async (filePath, where) => await installFromFile(install, filePath, where),
      uninstall: async (id) => { await uninstall(install, id) },
      setEnabled: async (id, enabled) => { await setEnabled(install, id, enabled) },
      list: () => readRegistry(userDataPath),
      installFromStore: store.installFromStore,
      checkForUpdates: store.checkForUpdates,
      updateFromStore: store.updateFromStore,
      prefs,
      commandKeys,
      applyManifest: manifests.applyManifest
    }
    installExtensionsInstallTestHook(extensionsApi)
    publishExtensions(ctx, extensionsApi)
  }
}
