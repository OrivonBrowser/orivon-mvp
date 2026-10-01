// Every extension API module, one per line, alphabetical. A lane adds its
// import and its entry next to its neighbours; `install-apis.ts` runs each
// once before the first extension loads.
import { actionUserSettingsApi } from '../action-pins-runner.js'
import { permissionsApi } from '../permissions-api.js'
import type { ExtensionApiModule } from './api-types.js'
import { commandsApi } from './commands-api.js'

export const EXTENSION_APIS: readonly ExtensionApiModule[] = [
  actionUserSettingsApi,
  commandsApi,
  permissionsApi
]
