// What every shell window in this process shares. A store built per window
// would give each its own in-memory copy of one file, and the last to write
// would win.
import { join } from 'node:path'
import { BookmarkStore } from '../browsing/bookmarks.js'
import { SettingsStore } from '../settings/settings-store.js'
import { WindowRegistry } from './window-registry.js'

export interface ShellServices {
  readonly bookmarks: BookmarkStore
  readonly settings: SettingsStore
  readonly windows: WindowRegistry
}

export function createShellServices (userDataPath: string): ShellServices {
  return {
    bookmarks: new BookmarkStore(join(userDataPath, 'bookmarks.json')),
    settings: new SettingsStore(join(userDataPath, 'settings.json')),
    windows: new WindowRegistry()
  }
}
