// What every shell window in this process shares. A store built per window
// would give each its own in-memory copy of one file, and the last to write
// would win.
import { join } from 'node:path'
import { BookmarkStore } from '../browsing/bookmarks.js'
import { InternalPageRegistry } from '../pages/internal-registry.js'
import { SettingsStore } from '../settings/settings-store.js'
import { CommandBus } from '../shortcuts/command-bus.js'
import { ShortcutService } from '../shortcuts/shortcut-service.js'
import { ShortcutStore } from '../shortcuts/shortcut-store.js'
import { ZoomService } from '../zoom/zoom-service.js'
import { ZoomStore } from '../zoom/zoom-store.js'
import { WindowRegistry } from './window-registry.js'

export interface ShellServices {
  readonly bookmarks: BookmarkStore
  readonly commands: CommandBus
  readonly internalPages: InternalPageRegistry
  readonly settings: SettingsStore
  readonly shortcuts: ShortcutService
  readonly shortcutStore: ShortcutStore
  readonly windows: WindowRegistry
  readonly zoom: ZoomService
  readonly zoomStore: ZoomStore
}

export function createShellServices (userDataPath: string, platform: NodeJS.Platform = process.platform): ShellServices {
  const shortcutStore = new ShortcutStore(join(userDataPath, 'shortcuts.json'), platform)
  const settings = new SettingsStore(join(userDataPath, 'settings.json'))
  const zoomStore = new ZoomStore(join(userDataPath, 'zoom.json'))
  return {
    bookmarks: new BookmarkStore(join(userDataPath, 'bookmarks.json')),
    commands: new CommandBus(),
    internalPages: new InternalPageRegistry(),
    settings,
    shortcuts: new ShortcutService(shortcutStore, platform),
    shortcutStore,
    windows: new WindowRegistry(),
    zoom: new ZoomService(zoomStore, settings),
    zoomStore
  }
}
