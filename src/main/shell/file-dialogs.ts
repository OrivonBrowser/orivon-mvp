// The one place a feature asks the person for a file or a folder. Each call reads `dialog.*` when it is
// made, so an end-to-end test that replaces those two methods sees every dialog Orivon opens.
import { dialog, type BaseWindow, type OpenDialogOptions, type SaveDialogOptions } from 'electron'

/** Where to save, or `undefined` when the person cancels. Sheet-modal to `window` when it is still open. */
export async function pickSaveFile (window: BaseWindow | undefined, options: SaveDialogOptions): Promise<string | undefined> {
  const result = window === undefined || window.isDestroyed() ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(window, options)
  return result.canceled || result.filePath === '' ? undefined : result.filePath
}

/** The one file chosen, or `undefined` on cancel. `properties` is the caller's to extend but never selects several. */
export async function pickOpenFile (window: BaseWindow | undefined, options: OpenDialogOptions): Promise<string | undefined> {
  return await pickOpen(window, { ...options, properties: ['openFile', ...(options.properties ?? []).filter((property) => property !== 'multiSelections' && property !== 'openDirectory')] })
}

/** The folder chosen, or `undefined` on cancel. */
export async function pickFolder (window: BaseWindow | undefined, options: OpenDialogOptions): Promise<string | undefined> {
  return await pickOpen(window, { ...options, properties: ['openDirectory', ...(options.properties ?? []).filter((property) => property !== 'multiSelections' && property !== 'openFile')] })
}

async function pickOpen (window: BaseWindow | undefined, options: OpenDialogOptions): Promise<string | undefined> {
  const result = window === undefined || window.isDestroyed() ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options)
  return result.canceled ? undefined : result.filePaths[0]
}
