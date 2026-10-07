// What every shell window in this process shares. A store built per window
// would give each its own in-memory copy of one file, and the last to write
// would win.
import { join } from 'node:path'
import { app, safeStorage, session } from 'electron'
import { BookmarkStore } from '../browsing/bookmarks.js'
import { defaultBookmarks } from '../default-profile/default-profile.js'
import { startsFromDefaultProfile } from '../default-profile/profile-start.js'
import { currentDefaultProfileDir } from '../default-profile/default-profile-dir.js'
import { SearchEngineStore } from '../browsing/search-engine-store.js'
import { InternalPageRegistry } from '../pages/internal-registry.js'
import { SettingsStore } from '../settings/settings-store.js'
import { isDevEthName } from '../dev/eth-resolver.js'
import type { UpdateOffer } from '../install/app-updates.js'
import { createScoreProviderClient, netFetchJson } from '../browsing/score-provider-client.js'
import type { ScoreProviderClient } from '../browsing/score-provider-client.js'
import { SHELL_PARTITION } from './shell-session.js'
import { isShellUiPage } from './shell-ui-page.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import { isOriginServedFromCacheSync } from '../../loader/electron/serve.js'
import { appOrigin } from './devtools-app-origin.js'
import { HistoryService } from '../history/history-service.js'
import { NullHistoryStore } from '../history/history-store.js'
import { openHistory } from '../history/open-history.js'
import { ProfilesService } from '../launch/profiles-service.js'
import { devPasswordStorage } from '../passwords/dev-password-storage.js'
import { openVault } from '../passwords/open-vault.js'
import type { PasswordVault } from '../passwords/vault.js'
import { SiteSettingsStore } from '../site-settings/site-settings-store.js'
import type { Runtime } from '../launch/start-launch.js'
import { devModeEnabled } from '../dev/dev-mode.js'
import { confirmOpenDevTools } from '../devtools/devtools-prompt.js'
import { DevToolsService } from '../devtools/devtools-service.js'
import { createDownloadService } from '../downloads/create-download-service.js'
import type { DownloadService } from '../downloads/download-service.js'
import { CommandBus } from '../shortcuts/command-bus.js'
import { ShortcutService } from '../shortcuts/shortcut-service.js'
import { ShortcutStore } from '../shortcuts/shortcut-store.js'
import { ZoomService } from '../zoom/zoom-service.js'
import { ZoomStore } from '../zoom/zoom-store.js'
import { ClosedStack } from '../session-restore/closed-stack.js'
import { watchClosedTabs } from '../session-restore/closed-tabs.js'
import { NullSessionStore, SessionStore } from '../session-restore/session-store.js'
import type { SessionLog } from '../session-restore/session-store.js'
import { createLoadedExtensions } from '../extensions/loaded-extensions.js'
import type { LoadedExtensions } from '../extensions/loaded-extensions.js'
import { DropCatcher } from './drop-catcher.js'
import { NativeTabDrag } from './native-tab-drag.js'
import { imageToDataUrl, previewSizeFor, TearDragController } from './tear-drag.js'
import { captureTabPage } from './tab-view.js'
import { WindowRegistry } from './window-registry.js'
import type { SubsystemContext } from '../registry.js'
import { TabLifecycle } from './tab-lifecycle.js'
import { KIOSK_FLAG } from '../window-state/kiosk.js'
import { FileWindowStateStore, NullWindowStateStore } from '../window-state/window-state-store.js'
import type { WindowStateStore } from '../window-state/window-state-store.js'

/** How long a press on a tab waits for its page's capture before the drag image is the tab itself. */
const THUMBNAIL_WAIT_MS = 400

export interface ShellServices {
  readonly bookmarks: BookmarkStore
  /** The tabs and windows closed, newest first: what Reopen closed tab brings back. In memory. */
  readonly closedTabs: ClosedStack
  readonly commands: CommandBus
  readonly devtools: DevToolsService
  /** The files tabs have downloaded and the ones in progress; a private session keeps the list in memory only. */
  readonly downloads: DownloadService
  /** The extensions loaded in the session pages run in, and when that changes. */
  readonly extensionsLoaded: LoadedExtensions
  readonly history: HistoryService
  readonly internalPages: InternalPageRegistry
  /** This process is a private session: it never writes a store file of its own. */
  readonly isPrivate: boolean
  /** This process was started with --orivon-kiosk (window-state/kiosk.ts). Read once, at start. */
  readonly kiosk: boolean
  /** The saved logins; this process's own memory until an encrypted store replaces it. */
  readonly passwords: PasswordVault
  readonly profiles: ProfilesService
  /** The open windows, kept in `session.json`; a private session writes nothing. */
  /** The engines a keyword searches: the built-in ones and the person's own; a private session reads the list and never changes it. */
  readonly searchEngines: SearchEngineStore
  readonly session: SessionLog
  readonly settings: SettingsStore
  /** The Web3 Score provider the person chose, with one cache for every window. */
  readonly scoreProvider: ScoreProviderClient
  /** The updates offered to installed apps at a name, for the key icon; empty until the app-update subsystem has published. */
  readonly updateOffers: {
    readonly pending: (origin: string) => UpdateOffer | undefined
    readonly onChange: (listener: (origin: string) => void) => () => void
  }
  /** What the person told each site it may do; a private session keeps it in memory. */
  readonly siteSettings: SiteSettingsStore
  readonly shortcuts: ShortcutService
  readonly shortcutStore: ShortcutStore
  /** The floating preview a tab shows once dragged out of its strip, and the mark it leaves on whichever
   * window's strip it is over -- one for the whole process, since only one tab can be mid-drag (tear-drag.ts). */
  readonly tearDrag: TearDragController
  /** The same drag where screen positions are unknown (a native Wayland session): the browser's own drag and
   * drop, with a catcher over every window's page (native-tab-drag.ts). */
  readonly nativeDrag: NativeTabDrag
  /** Every window's tab lifecycle, mirrored here (tab-lifecycle.ts) -- one
   * instance for the whole process, so a subscriber (the extension host)
   * hears every window, not just the one it happened to attach to first. */
  readonly tabLifecycle: TabLifecycle
  readonly windows: WindowRegistry
  /** Where the last-used window was; a private session keeps nothing. */
  readonly windowState: WindowStateStore
  readonly zoom: ZoomService
  readonly zoomStore: ZoomStore
}

export function createShellServices (userDataPath: string, runtime: Runtime, ctx: SubsystemContext, platform: NodeJS.Platform = process.platform): ShellServices {
  const shortcutStore = new ShortcutStore(join(userDataPath, 'shortcuts.json'), platform)
  const settings = new SettingsStore(join(userDataPath, 'settings.json'))
  const zoomStore = new ZoomStore(join(userDataPath, 'zoom.json'))
  const internalPages = new InternalPageRegistry()
  const windows = new WindowRegistry()
  const tabLifecycle = new TabLifecycle()
  const closedTabs = new ClosedStack()
  // A kiosk runs on the person's own profile but is not their browsing: it records no session, offers none back
  // and starts no other browser.
  const kiosk = app.commandLine.hasSwitch(KIOSK_FLAG.slice(2))
  watchClosedTabs(tabLifecycle, closedTabs)
  // A private session writes down no pages: it never opens a history file at all.
  const openedHistory = runtime.isPrivate ? { store: new NullHistoryStore(), problem: null } : openHistory(join(userDataPath, 'history.db'))
  return {
    bookmarks: new BookmarkStore(join(userDataPath, 'bookmarks.json'), undefined, undefined, startsFromDefaultProfile() ? () => defaultBookmarks(currentDefaultProfileDir()) : undefined),
    closedTabs,
    commands: new CommandBus(),
    devtools: new DevToolsService(settings, {
      // A security prompt: it must key on the app HOLDING GRANTS (ADR-0044)
      // or being cache-served, never on whether its tab happens to sit in
      // its own partition -- a granted origin served from the network runs
      // in the shared default session, same as every other site.
      appOf: (contents) => {
        const origin = appOrigin(originFromUrl, contents)
        if (origin === null) return null
        const isApp = ctx.broker?.app.hasGrantsSync(origin) === true || isOriginServedFromCacheSync(origin)
        if (!isApp) return null
        return { key: origin, label: origin }
      },
      isShellPage: (contents) => isShellUiPage(contents, internalPages, session.fromPartition(SHELL_PARTITION)),
      developerMode: devModeEnabled,
      confirm: confirmOpenDevTools
    }),
    downloads: createDownloadService(userDataPath, runtime.isPrivate, settings),
    extensionsLoaded: createLoadedExtensions(session.defaultSession),
    history: new HistoryService(openedHistory.store, settings, openedHistory.problem, Date.now, (from, to) => { closedTabs.forgetBetween(from, to) }),
    internalPages,
    isPrivate: runtime.isPrivate,
    kiosk,
    passwords: openVault({ path: join(userDataPath, 'passwords.json'), isPrivate: runtime.isPrivate, storage: devPasswordStorage() ?? safeStorage }),
    profiles: new ProfilesService(runtime, undefined, kiosk),
    searchEngines: new SearchEngineStore(join(userDataPath, 'search-engines.json'), { readOnly: runtime.isPrivate }),
    session: runtime.isPrivate || kiosk ? new NullSessionStore() : new SessionStore(join(userDataPath, 'session.json')),
    settings,
    scoreProvider: createScoreProviderClient({ providerAddress: () => settings.get('web3.scoreProvider'), isDevEthName, fetchJson: netFetchJson }),
    updateOffers: {
      pending: (origin) => ctx.appUpdates?.pending(origin),
      onChange: (listener) => ctx.appUpdates?.onChange(listener) ?? (() => {})
    },
    siteSettings: new SiteSettingsStore(runtime.isPrivate ? null : join(userDataPath, 'site-settings.json')),
    shortcuts: new ShortcutService(shortcutStore, platform),
    shortcutStore,
    tearDrag: new TearDragController(() => windows.all()),
    nativeDrag: new NativeTabDrag({
      windows: () => windows.all(),
      clock: { after: (ms, fn) => { const timer = setTimeout(fn, ms); return () => { clearTimeout(timer) } } },
      catcher: (window, hooks) => new DropCatcher(window.window, window.chromeHeight, import.meta.dirname, hooks),
      thumbnail: async (source, tabId) => {
        const { width, height } = source.window.getContentBounds()
        // A page that is not on screen may never answer a capture.
        const image = await Promise.race([captureTabPage(source.tabs.liveWebContents(tabId)), new Promise<null>((resolve) => { setTimeout(resolve, THUMBNAIL_WAIT_MS, null) })])
        return imageToDataUrl(image, previewSizeFor(width, height))
      }
    }),
    tabLifecycle,
    windows,
    windowState: runtime.isPrivate ? new NullWindowStateStore() : new FileWindowStateStore(join(userDataPath, 'window-state.json')),
    zoom: new ZoomService(zoomStore, settings),
    zoomStore
  }
}
