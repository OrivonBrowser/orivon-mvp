// Every extension API module, one per line, alphabetical. A lane adds its
// import and its entry next to its neighbours; `install-apis.ts` runs each
// once before the first extension loads.
import { actionUserSettingsApi } from '../action-pins-runner.js'
import { permissionsApi } from '../permissions-api.js'
import { webRequestApi } from '../web-request-api.js'
import type { ExtensionApiModule } from './api-types.js'
import { bookmarksApi } from './bookmarks-api.js'
import { commandsApi } from './commands-api.js'
import { historyApi, topSitesApi } from './history-api.js'
import { runtimeApi } from './runtime-api.js'
import { searchApi } from './search-api.js'

export const EXTENSION_APIS: readonly ExtensionApiModule[] = [
  actionUserSettingsApi,
  bookmarksApi,
  commandsApi,
  historyApi,
  permissionsApi,
  runtimeApi,
  searchApi,
  topSitesApi,
  webRequestApi
]
