// What every shell window in this process shares. A store built per window
// would give each its own in-memory copy of one file, and the last to write
// would win.
import { join } from 'node:path'
import { session } from 'electron'
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
import type { Runtime } from '../launch/start-launch.js'
import { devModeEnabled } from '../dev/dev-mode.js'
import { confirmOpenDevTools } from '../devtools/devtools-prompt.js'
import { DevToolsService } from '../devtools/devtools-service.js'
import { CommandBus } from '../shortcuts/command-bus.js'
import { ShortcutService } from '../shortcuts/shortcut-service.js'
import { ShortcutStore } from '../shortcuts/shortcut-store.js'
import { ZoomService } from '../zoom/zoom-service.js'
import { ZoomStore } from '../zoom/zoom-store.js'
import { TearDragController } from './tear-drag.js'
import { WindowRegistry } from './window-registry.js'
import type { SubsystemContext } from '../registry.js'
import { TabLifecycle } from './tab-lifecycle.js'

export interface ShellServices {
  readonly bookmarks: BookmarkStore
  readonly commands: CommandBus
  readonly devtools: DevToolsService
  readonly history: HistoryService
  readonly internalPages: InternalPageRegistry
  /** This process is a private session: it never writes a store file of its own. */
  readonly isPrivate: boolean
  readonly profiles: ProfilesService
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
  readonly zoom: ZoomService
  readonly zoomStore: ZoomStore
}

export function createShellServices (userDataPath: string, runtime: Runtime, ctx: SubsystemContext, platform: NodeJS.Platform = process.platform): ShellServices {
  const shortcutStore = new ShortcutStore(join(userDataPath, 'shortcuts.json'), platform)
  const settings = new SettingsStore(join(userDataPath, 'settings.json'))
  const zoomStore = new ZoomStore(join(userDataPath, 'zoom.json'))
  const internalPages = new InternalPageRegistry()
  const windows = new WindowRegistry()
  // A private session writes down no pages: it never opens a history file at all.
  const openedHistory = runtime.isPrivate ? { store: new NullHistoryStore(), problem: null } : openHistory(join(userDataPath, 'history.db'))
  return {
    bookmarks: new BookmarkStore(join(userDataPath, 'bookmarks.json')),
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
    history: new HistoryService(openedHistory.store, settings, openedHistory.problem),
    internalPages,
    isPrivate: runtime.isPrivate,
    profiles: new ProfilesService(runtime),
    settings,
    shortcuts: new ShortcutService(shortcutStore, platform),
    shortcutStore,
    tearDrag: new TearDragController(() => windows.all()),
    tabLifecycle: new TabLifecycle(),
    windows,
    zoom: new ZoomService(zoomStore, settings),
    zoomStore
  }
}
