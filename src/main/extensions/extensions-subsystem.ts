// Registers extensions on `afterReady`: constructs the electron-chrome-
// extensions library (ADR-0043) on session.defaultSession, then loads every
// enabled registry entry into it, then publishes install/uninstall/enable/
// list to `ctx.extensions`. Listed after `verifierSubsystem` in
// `../subsystems.ts` -- README.md's Design notes say why. The library must
// exist BEFORE the first loadExtension() call, so its own 'extension-loaded'
// listener sees every extension (extension-host.ts's own header).

import { join } from 'node:path'
import { session } from 'electron'
import type { Subsystem, SubsystemContext } from '../registry.js'
import { publishExtensions } from '../registry.js'
import { readRegistry } from './registry-runner.js'
import { installFromFile, installFromFolder, setEnabled, uninstall, type InstallContext, type InstallOutcome } from './install-runner.js'
import { createExtensionInstallPrompt } from './extension-install-prompt.js'
import { createExtensionHost } from './extension-host.js'
import { startWebStore } from './store-runner.js'
import { installStoreTestHook } from './store-test-hook.js'
import type { InstalledExtension } from './registry.js'
import { attachExtensionsDnr, getDnrEngine } from './extensions-dnr.js'
import { installDnrPermissionCheck, registerDnrApiHandlers } from './dnr-api.js'
import { installDnrWebRequestHandlers } from './dnr-webrequest.js'

export interface ExtensionsApi {
  readonly installFromFolder: (dir: string) => Promise<InstallOutcome>
  readonly installFromFile: (filePath: string) => Promise<InstallOutcome>
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

export const extensionsSubsystem: Subsystem = {
  name: 'extensions',
  afterReady: async (ctx: SubsystemContext) => {
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
    installDnrPermissionCheck(session.defaultSession, userDataPath)
    const onRuleMatched = registerDnrApiHandlers(hostExtensions.getRouter(), userDataPath)
    installDnrWebRequestHandlers(session.defaultSession, getDnrEngine, onRuleMatched)

    await loadEnabledExtensions(userDataPath)

    const install: InstallContext = { userDataPath, session: session.defaultSession, prompt: createExtensionInstallPrompt() }
    const preloadPath = join(import.meta.dirname, '../preload/web-store.js')
    const store = await startWebStore(install, preloadPath)
    installStoreTestHook(store)
    publishExtensions(ctx, {
      installFromFolder: async (dir) => await installFromFolder(install, dir),
      installFromFile: async (filePath) => await installFromFile(install, filePath),
      uninstall: async (id) => { await uninstall(install, id) },
      setEnabled: async (id, enabled) => { await setEnabled(install, id, enabled) },
      list: () => readRegistry(userDataPath),
      installFromStore: store.installFromStore,
      checkForUpdates: store.checkForUpdates,
      updateFromStore: store.updateFromStore
    })
  }
}
