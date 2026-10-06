import { app, session } from 'electron'
import { join } from 'node:path'
import { liveCspHeaderFor } from '../../loader/electron/serve.js'
import type { Subsystem } from '../registry.js'
import { guardFileScheme, serveLocalFiles } from './install-file-guard.js'
import { sweepLocalData } from './local-data-sweep.js'
import { LOCAL_FILES_PARTITION } from './partition.js'

/** The built shell pages, as `rendererEntryUrl` resolves them from `out/main`. */
function shellPagesRoot (): string {
  return join(import.meta.dirname, '../renderer')
}

/**
 * Where documents opened from this computer run, and what they may read. Every session answers `file:`
 * through `createFileHandler`: the local-files session serves files under the local-file policy, every
 * other session serves its own shell pages and nothing else. A boundary that stopped enforcing would
 * let a downloaded page read other files, so a failure here is critical.
 */
export const localFilesSubsystem: Subsystem = {
  name: 'local-files',
  critical: true,
  beforeReady: () => {
    const userData = app.getPath('userData')
    sweepLocalData(userData)
    app.on('session-created', (created) => { guardFileScheme(created, shellPagesRoot()) })
    app.on('will-quit', () => { sweepLocalData(userData) })
  },
  afterReady: (ctx) => {
    // The default session may have been created before `beforeReady`'s listener existed.
    guardFileScheme(session.defaultSession, shellPagesRoot())
    serveLocalFiles(session.fromPartition(LOCAL_FILES_PARTITION), async (key) => {
      const broker = ctx.broker
      return broker !== undefined && broker.app.hasGrantsSync(key) ? await liveCspHeaderFor(broker, key) : undefined
    })
  }
}
