// What every shell window in this process shares. A store built per window
// would give each its own in-memory copy of one file, and the last to write
// would win.
import { join } from 'node:path'
import { app, session } from 'electron'
import { BookmarkStore } from '../browsing/bookmarks.js'
import { InternalPageRegistry } from '../pages/internal-registry.js'
import { SettingsStore } from '../settings/settings-store.js'
import { SHELL_PARTITION } from './shell-session.js'
import { isShellUiPage } from './shell-ui-page.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import { isOriginServedFromCacheSync } from '../../loader/electron/serve.js'
import { appOrigin } from './devtools-app-origin.js'
import { HistoryService } from '../history/history-service.js'
import { NullHistoryStore } from '../history/history-store.js'
import { openHistory } from '../history/open-history.js'
import { ProfilesService } from '../launch/profiles-service.js'
import { memoryVault, type PasswordVault } from '../passwords/vault.js'
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
import { TearDragController } from './tear-drag.js'
import { WindowRegistry } from './window-registry.js'
import type { SubsystemContext } from '../registry.js'
import { TabLifecycle } from './tab-lifecycle.js'
import { KIOSK_FLAG } from '../window-state/kiosk.js'
import { FileWindowStateStore, NullWindowStateStore } from '../window-state/window-state-store.js'
import type { WindowStateStore } from '../window-state/window-state-store.js'

export interface ShellServices {
  readonly bookmarks: BookmarkStore
  /** The tabs and windows closed, newest first: what Reopen closed tab brings back. In memory. */
  readonly closedTabs: ClosedStack
  readonly commands: CommandBus
  readonly devtools: DevToolsService
  /** The files tabs have downloaded and the ones in progress; a private session keeps the list in memory only. */
  readonly downloads: DownloadService
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
  readonly session: SessionLog
  readonly settings: SettingsStore
  readonly shortcuts: ShortcutService
  readonly shortcutStore: ShortcutStore
  /** The floating preview a tab shows once dragged out of its strip, and the mark it leaves on whichever
   * window's strip it is over -- one for the whole process, since only one tab can be mid-drag (tear-drag.ts). */
  readonly tearDrag: TearDragController
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
    bookmarks: new BookmarkStore(join(userDataPath, 'bookmarks.json')),
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
    history: new HistoryService(openedHistory.store, settings, openedHistory.problem),
    internalPages,
    isPrivate: runtime.isPrivate,
    kiosk,
    passwords: memoryVault(),
    profiles: new ProfilesService(runtime, undefined, kiosk),
    session: runtime.isPrivate || kiosk ? new NullSessionStore() : new SessionStore(join(userDataPath, 'session.json')),
    settings,
    shortcuts: new ShortcutService(shortcutStore, platform),
    shortcutStore,
    tearDrag: new TearDragController(() => windows.all()),
    tabLifecycle,
    windows,
    windowState: runtime.isPrivate ? new NullWindowStateStore() : new FileWindowStateStore(join(userDataPath, 'window-state.json')),
    zoom: new ZoomService(zoomStore, settings),
    zoomStore
  }
}
