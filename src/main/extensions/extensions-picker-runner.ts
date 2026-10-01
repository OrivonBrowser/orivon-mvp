// The native pickers Developer mode's buttons open: a folder for Load
// unpacked, a `.crx`/`.zip` file for Install from file. The page only asks
// for one of these -- it never sends a path of its own. An OS picker stays
// native, but is parented to the window of the extensions page that asked.
import type { BaseWindow } from 'electron'
import { pickFolder, pickOpenFile } from '../shell/file-dialogs.js'

export async function pickExtensionFolder (window: BaseWindow | undefined): Promise<string | undefined> {
  return await pickFolder(window, {})
}

export async function pickExtensionFile (window: BaseWindow | undefined): Promise<string | undefined> {
  return await pickOpenFile(window, { filters: [{ name: 'Extension', extensions: ['crx', 'zip'] }] })
}
