// Hands the namespace list to the library's preload. Imported by
// ../extension-api.ts before the library's own preload, which reads the list
// when it injects.
import { setExtraMainWorldApis } from '../../../vendor/electron-chrome-extensions/src/renderer/extras.js'
import { EXTENSION_MAIN_WORLD_APIS } from './apis.js'

setExtraMainWorldApis(EXTENSION_MAIN_WORLD_APIS)
