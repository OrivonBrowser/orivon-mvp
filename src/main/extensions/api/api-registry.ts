// Every extension API module, one per line, alphabetical. A lane adds its
// import and its entry next to its neighbours; `install-apis.ts` runs each
// once before the first extension loads.
import { actionUserSettingsApi } from '../action-pins-runner.js'
import type { ExtensionApiModule } from './api-types.js'

export const EXTENSION_APIS: readonly ExtensionApiModule[] = [
  actionUserSettingsApi
]
