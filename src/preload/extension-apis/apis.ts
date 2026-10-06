import { actionSettingsApi } from './action-settings.js'
import { bookmarksApi } from './bookmarks.js'
import { commandsApi } from './commands.js'
import { declarativeNetRequestApi } from './declarative-net-request.js'
import { historyApi } from './history.js'
import { permissionsApi } from './permissions.js'
import { runtimeApi } from './runtime.js'
import { searchApi } from './search.js'
import { sidePanelApi } from './side-panel.js'
import { topSitesApi } from './top-sites.js'
import { webRequestApi } from './web-request.js'

// The namespaces Orivon adds to `chrome.*` in an extension's own main world,
// one per line, alphabetical. Each entry is ONE function with no import and
// no identifier from outside its own body: the library runs it with
// `contextBridge.executeInMainWorld`, which sends the function's source text
// and nothing else. tests/self-contained.test.ts rebuilds every entry from its
// source against a fake `__crx` and fails on a stray reference.
//
// An entry looks like this (a namespace whose permission is `history`):
//
//   export function historyApi (): void {
//     const crx = (globalThis as unknown as { __crx: Crx }).__crx
//     if (!crx.declares('history')) return
//     crx.define('history', () => ({
//       search: crx.call('history.search'),
//       onVisited: crx.event('history.onVisited')
//     }))
//   }
export const EXTENSION_MAIN_WORLD_APIS: ReadonlyArray<() => void> = [
  actionSettingsApi,
  bookmarksApi,
  commandsApi,
  declarativeNetRequestApi,
  historyApi,
  permissionsApi,
  runtimeApi,
  searchApi,
  sidePanelApi,
  topSitesApi,
  webRequestApi
]
