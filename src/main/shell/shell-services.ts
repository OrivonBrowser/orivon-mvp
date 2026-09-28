// What every shell window in this process shares. A store built per window
// would give each its own in-memory copy of one file, and the last to write
// would win.
import { join } from 'node:path'
import { BookmarkStore } from '../browsing/bookmarks.js'
import { InternalPageRegistry } from '../pages/internal-registry.js'
import { SettingsStore } from '../settings/settings-store.js'
import { partitionForTarget } from './tab-view.js'
import { devModeEnabled } from '../dev/dev-mode.js'
import { confirmOpenDevTools } from '../devtools/devtools-prompt.js'
import { DevToolsService } from '../devtools/devtools-service.js'
import type { SubsystemContext } from '../registry.js'
import { CommandBus } from '../shortcuts/command-bus.js'
import { ShortcutService } from '../shortcuts/shortcut-service.js'
import { ShortcutStore } from '../shortcuts/shortcut-store.js'
import { ZoomService } from '../zoom/zoom-service.js'
import { ZoomStore } from '../zoom/zoom-store.js'
import { WindowRegistry } from './window-registry.js'

export interface ShellServices {
  readonly bookmarks: BookmarkStore
  readonly commands: CommandBus
  readonly devtools: DevToolsService
  readonly internalPages: InternalPageRegistry
  readonly settings: SettingsStore
  readonly shortcuts: ShortcutService
  readonly shortcutStore: ShortcutStore
  readonly windows: WindowRegistry
  readonly zoom: ZoomService
  readonly zoomStore: ZoomStore
}

/** `ctx.broker` is read when a page is asked about, not now: the broker is published after the shell starts. */
export function createShellServices (userDataPath: string, ctx: Pick<SubsystemContext, 'broker'>, platform: NodeJS.Platform = process.platform): ShellServices {
  const shortcutStore = new ShortcutStore(join(userDataPath, 'shortcuts.json'), platform)
  const settings = new SettingsStore(join(userDataPath, 'settings.json'))
  const zoomStore = new ZoomStore(join(userDataPath, 'zoom.json'))
  const internalPages = new InternalPageRegistry()
  return {
    bookmarks: new BookmarkStore(join(userDataPath, 'bookmarks.json')),
    commands: new CommandBus(),
    devtools: new DevToolsService(settings, {
      isApp: (url) => partitionForTarget(url, ctx.broker) !== undefined,
      isShellPage: (contents) => internalPages.pageOf(contents) !== undefined,
      developerMode: devModeEnabled,
      confirm: confirmOpenDevTools
    }),
    internalPages,
    settings,
    shortcuts: new ShortcutService(shortcutStore, platform),
    shortcutStore,
    windows: new WindowRegistry(),
    zoom: new ZoomService(zoomStore, settings),
    zoomStore
  }
}
