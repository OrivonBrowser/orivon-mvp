// The one place the subsystem obtains the preferences store, so what backs it
// (memory for a private runtime, a file under the profile otherwise) changes
// in one line.
import { createMemoryExtensionPrefs, type ExtensionPrefsStore } from './extension-prefs-stub.js'

export function openExtensionPrefs (_userDataPath: string, _privateSession: boolean): ExtensionPrefsStore {
  return createMemoryExtensionPrefs()
}
