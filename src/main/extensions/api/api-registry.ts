// Every extension API module, one per line, alphabetical. A lane adds its
// import and its entry next to its neighbours; `install-apis.ts` runs each
// once before the first extension loads.
import { actionUserSettingsApi, profileActionSettingsApi } from '../action-pins-runner.js'
import { permissionsApi } from '../permissions-api.js'
import { webRequestApi } from '../web-request-api.js'
import type { ExtensionApiModule } from './api-types.js'
import { bookmarksApi } from './bookmarks-api.js'
import { commandsApi } from './commands-api.js'
import { historyApi, topSitesApi } from './history-api.js'
import { runtimeApi } from './runtime-api.js'
import { searchApi } from './search-api.js'
import { sidePanelApi } from '../side-panel-runner.js'

export const EXTENSION_APIS: readonly ExtensionApiModule[] = [
  actionUserSettingsApi,
  bookmarksApi,
  commandsApi,
  historyApi,
  permissionsApi,
  runtimeApi,
  searchApi,
  sidePanelApi,
  topSitesApi,
  webRequestApi
]

/**
 * What the library instance of a profile session gets: every API of the default session's, but the side panel, whose pages are
 * views the shell mounts beside the default session's tabs. The action settings are the per-instance part only.
 */
export const PROFILE_EXTENSION_APIS: readonly ExtensionApiModule[] = EXTENSION_APIS
  .filter((module) => module !== sidePanelApi)
  .map((module) => module === actionUserSettingsApi ? profileActionSettingsApi : module)
