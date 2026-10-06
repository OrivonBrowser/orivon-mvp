import { app, session } from 'electron'
import { join } from 'node:path'
import { liveCspHeaderFor } from '../../loader/electron/serve.js'
import { webRequestOwnerFor } from '../sessions/web-request-owner.js'
import type { Subsystem } from '../registry.js'
import { fileProtocolFuse } from './file-fuse.js'
import { LocalFileApps, installLocalFileApps } from './local-file-apps.js'
import { ensureLocalSession, prepareLocalSession, setLocalSessionPreparer } from './local-partition.js'
import { LOCAL_FILES_PARTITION } from './partition.js'
import { refuseFileScheme } from './refuse-file-scheme.js'

/**
 * Where documents opened from this computer run, and what every other session answers `file:` with.
 * A local-files session serves files through `createFileHandler` and fences off the files that belong to
 * another one; every other session answers 404. A boundary that stopped enforcing would let a downloaded
 * page read other files, so a failure here is critical.
 */
export const localFilesSubsystem: Subsystem = {
  name: 'local-files',
  critical: true,
  beforeReady: () => {
    installLocalFileApps(new LocalFileApps(join(app.getPath('userData'), 'local-file-apps.json')))
    app.on('session-created', (created) => { refuseFileScheme(created) })
  },
  afterReady: async (ctx) => {
    // The default session may have been created before `beforeReady`'s listener existed.
    refuseFileScheme(session.defaultSession)
    setLocalSessionPreparer((partition) => {
      prepareLocalSession(session.fromPartition(partition), partition, {
        owner: webRequestOwnerFor,
        fuse: fileProtocolFuse,
        extraPolicy: async (key) => {
          const broker = ctx.broker
          return broker !== undefined && broker.app.hasGrantsSync(key) ? await liveCspHeaderFor(broker, key, { inlineScripts: true }) : undefined
        }
      })
    })
    ensureLocalSession(LOCAL_FILES_PARTITION)
  }
}
