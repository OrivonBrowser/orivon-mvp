// The native pickers Developer mode's buttons open: a folder for Load
// unpacked, a `.crx`/`.zip` file for Install from file. The page only asks
// for one of these -- it never sends a path of its own -- matching
// `extension-install-prompt.ts`'s own choice of no parent window.
import { dialog } from 'electron'

export async function pickExtensionFolder (): Promise<string | undefined> {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  return result.canceled ? undefined : result.filePaths[0]
}

export async function pickExtensionFile (): Promise<string | undefined> {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Extension', extensions: ['crx', 'zip'] }]
  })
  return result.canceled ? undefined : result.filePaths[0]
}
