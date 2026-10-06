// Builds the downloads service for this process: a list kept in <userData>/downloads.json, or held in memory
// only in a private session.
import { join } from 'node:path'
import type { SettingsStore } from '../settings/settings-store.js'
import { isRecordedLocalPath } from '../local-files/local-file-apps.js'
import { DownloadService } from './download-service.js'
import { JsonDownloadStore, MemoryDownloadStore } from './download-store.js'
import { machineDeps } from './folder-runner.js'

export function createDownloadService (userDataPath: string, isPrivate: boolean, settings: SettingsStore): DownloadService {
  return new DownloadService(isPrivate ? new MemoryDownloadStore() : new JsonDownloadStore(join(userDataPath, 'downloads.json')), { ...machineDeps(settings), reservedPath: isRecordedLocalPath })
}
