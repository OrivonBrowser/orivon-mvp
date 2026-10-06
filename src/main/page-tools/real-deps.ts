// The page tools' real dependencies: the file system, the clipboard and the save dialog.
import { app, clipboard, ClipboardItem, screen, shell } from 'electron'
import { rename, rm, writeFile } from 'node:fs/promises'
import { isRecordedLocalPath } from '../local-files/local-file-apps.js'
import { pickSaveFile } from '../shell/file-dialogs.js'
import type { PageToolDeps } from './deps.js'

export const realDeps: PageToolDeps = {
  pickSave: pickSaveFile,
  downloadsDir: () => app.getPath('downloads'),
  reservedPath: isRecordedLocalPath,
  writeFile: async (path, data) => { await writeFile(path, data) },
  rename,
  remove: async (path) => { await rm(path, { force: true }) },
  displayScale: (window) => window === undefined || window.isDestroyed() ? screen.getPrimaryDisplay().scaleFactor : screen.getDisplayMatching(window.getBounds()).scaleFactor,
  reveal: (path) => { shell.showItemInFolder(path) },
  copyImage: async (png) => {
    const blob = new Blob([new Uint8Array(png)], { type: 'image/png' })
    await clipboard.write([new ClipboardItem({ 'image/png': blob })])
  },
  now: () => new Date(),
  wait: async (ms) => { await new Promise<void>((resolve) => setTimeout(resolve, ms)) }
}
