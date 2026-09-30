// The shortcut sheet wired to the real machine, for the registry in ../overlays/overlays.ts.
import { app, shell } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { shortcutOverlayFor } from './shortcut-overlay.js'

export const shortcutOverlay = shortcutOverlayFor({
  get platform () { return process.platform },
  get isPackaged () { return app.isPackaged },
  get appPath () { return app.getAppPath() },
  get execPath () { return process.execPath },
  env: () => process.env,
  home: () => app.getPath('home'),
  desktop: () => app.getPath('desktop'),
  makeDirectory: async (path) => { await mkdir(path, { recursive: true }) },
  writeFile: async (path, text, mode) => { await writeFile(path, text, { mode }) },
  writeLink: (path, options) => shell.writeShortcutLink(path, 'create', options)
})
