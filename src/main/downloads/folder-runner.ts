// Where downloads go, and the operations on the machine the downloads service needs: the folder, the file
// manager, the trash. The only place in this directory that touches Electron's `app` and `shell`.
import { randomBytes } from 'node:crypto'
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, session, shell } from 'electron'
import type { BaseWindow } from 'electron'
import type { ShellServices } from '../shell/shell-services.js'
import type { SettingsStore } from '../settings/settings-store.js'
import { pickFolder } from '../shell/file-dialogs.js'
import type { DownloadDeps } from './download-service.js'
import type { DownloadsHost } from './downloads-domain.js'

/** The folder the operating system offers for downloads. */
export function systemDownloadsFolder (): string {
  try {
    return app.getPath('downloads')
  } catch {
    return join(app.getPath('home'), 'Downloads')
  }
}

/** The folder in effect: the one chosen in Settings, else the operating system's. */
export function downloadsFolder (settings: Pick<SettingsStore, 'get'>): string {
  const chosen = settings.get('downloads.folder')
  return chosen === '' ? systemDownloadsFolder() : chosen
}

/** The folder the person picks, or undefined when they cancel. */
export async function chooseFolder (window: BaseWindow | undefined, current: string): Promise<string | undefined> {
  return await pickFolder(window, { title: 'Choose where to save downloads', defaultPath: current })
}

function folderWritable (dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** The service's view of this machine. Each call reads `shell` and `session` when made, so a test that replaces them sees every use. */
export function machineDeps (settings: Pick<SettingsStore, 'get'>): DownloadDeps {
  return {
    folder: () => downloadsFolder(settings),
    fallbackFolder: systemDownloadsFolder,
    askWhere: () => settings.get('downloads.askWhere'),
    fileExists: existsSync,
    ensureFolder: (dir) => {
      try {
        mkdirSync(dir, { recursive: true })
      } catch {
        return false
      }
      return folderWritable(dir)
    },
    folderWritable,
    openPath: async (path) => await shell.openPath(path),
    showInFolder: (path) => { shell.showItemInFolder(path) },
    trash: async (path) => { await shell.trashItem(path) },
    fetchAgain: (url) => { session.defaultSession.downloadURL(url) },
    now: Date.now,
    newId: () => randomBytes(8).toString('hex')
  }
}

/** What the pages may do with the folder: look at it, open it, choose another, go back to the system's. */
export function downloadsHost (services: Pick<ShellServices, 'isPrivate' | 'settings' | 'windows'>): DownloadsHost {
  const { settings } = services
  return {
    isPrivate: services.isPrivate,
    folder: () => downloadsFolder(settings),
    isCustomFolder: () => !settings.isDefault('downloads.folder'),
    openFolder: async () => {
      const folder = downloadsFolder(settings)
      mkdirSync(folder, { recursive: true })
      await shell.openPath(folder)
    },
    chooseFolder: async (contents) => {
      const chosen = await chooseFolder(services.windows.findOwner(contents)?.window, downloadsFolder(settings))
      return chosen !== undefined && settings.set('downloads.folder', chosen).ok
    },
    resetFolder: () => { settings.reset('downloads.folder') }
  }
}
