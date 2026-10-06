// "Open file…": the person picks a document on this computer and it opens as a local file, in front.
import type { OpenDialogOptions } from 'electron'
import { parseLocalFileInput } from '../browsing/local-file-input.js'
import { pickOpenFile } from './file-dialogs.js'
import { openFromBrowser } from './open-from-browser.js'
import type { ShellWindow } from './window-registry.js'

const OPTIONS: OpenDialogOptions = {
  title: 'Open file',
  filters: [
    { name: 'Web pages and documents', extensions: ['html', 'htm', 'xhtml', 'svg', 'pdf'] },
    { name: 'All files', extensions: ['*'] }
  ]
}

export async function openFileCommand (
  target: ShellWindow,
  pick: (window: ShellWindow['window'], options: OpenDialogOptions) => Promise<string | undefined> = pickOpenFile,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const path = await pick(target.window, OPTIONS)
  if (path === undefined) return
  const url = parseLocalFileInput(path, platform)
  if (url !== null) openFromBrowser(target.tabs, url)
}
