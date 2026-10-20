// The Import page's view of this machine: where other browsers keep their files, the file dialog, and the two
// stores an import writes to. The only file in this directory that imports `electron`.
import { join } from 'node:path'
import { app } from 'electron'
import { commandById } from '../shortcuts/commands.js'
import { pickOpenFile } from '../shell/file-dialogs.js'
import type { ShellServices } from '../shell/shell-services.js'
import { candidateRoots } from './browser-roots.js'
import { detectSources } from './browser-profiles.js'
import { importLocation } from './import-test-seam.js'
import { nodeImportFs } from './import-fs.js'
import { runHtmlImport, runImport } from './import-runner.js'
import type { ImportDeps } from './import-runner.js'
import type { ImportHost } from './import-domain.js'
import { MAX_IMPORT_BYTES } from './import-types.js'
import type { ImportResult, ImportSource } from './import-types.js'

export interface ImportHostServices extends Pick<ShellServices, 'bookmarks' | 'history' | 'isPrivate' | 'settings' | 'windows' | 'commands' | 'featured'> {}

async function detectHere (): Promise<ImportSource[]> {
  const place = importLocation({ platform: process.platform, home: app.getPath('home'), env: process.env })
  return await detectSources(nodeImportFs, candidateRoots(place.platform, place.home, place.env))
}

/** Whether another browser's profile can be read on this computer. */
export async function otherBrowserFound (): Promise<boolean> {
  return (await detectHere()).length > 0
}

/** `publish` tells the page which part of an import is running. */
export function importHost (services: ImportHostServices, publish: (phase: 'bookmarks' | 'history') => void): ImportHost {
  const deps = (): ImportDeps => ({
    fs: nodeImportFs,
    bookmarks: services.bookmarks,
    history: services.history,
    now: Date.now,
    retentionDays: () => {
      const days = services.settings.get('history.retentionDays')
      return days === 'forever' ? null : Number(days)
    },
    progress: publish,
    // On the profile's own disk, never the system's temporary folder, which may be held in memory: a browser's history
    // can be hundreds of megabytes, and the copy of it lives only while it is read.
    tempDir: join(app.getPath('userData'), 'import-tmp')
  })
  /** An import that ran to the end ticks the new tab's "Start here" step. */
  const finished = (result: ImportResult): ImportResult => {
    if (result.error === undefined) services.featured.markStep('import')
    return result
  }
  return {
    isPrivate: services.isPrivate,
    detect: detectHere,
    historyOn: () => services.settings.get('history.remember'),
    managerAvailable: () => commandById('bookmarks.open')?.pending !== true,
    run: async (source, what) => finished(await runImport(source, what, deps())),
    runFile: async (contents) => {
      const path = await pickOpenFile(services.windows.findOwner(contents)?.window, {
        title: 'Choose a bookmarks file',
        filters: [{ name: 'Bookmarks file', extensions: ['html', 'htm'] }]
      })
      if (path === undefined) return undefined
      // A file that is missing or too large reads as text that is no bookmarks file.
      return finished(runHtmlImport(await nodeImportFs.readText(path, MAX_IMPORT_BYTES) ?? '', deps()))
    },
    openManager: (contents) => {
      const window = services.windows.findOwner(contents)
      if (window !== undefined) services.commands.run('bookmarks.open', window)
    }
  }
}
