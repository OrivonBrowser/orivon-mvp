// Where this run finds the default profile's files. The only place that asks Electron whether the app is packaged.
import { app } from 'electron'
import { defaultProfileDir } from './default-profile.js'

export function currentDefaultProfileDir (): string {
  return defaultProfileDir({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, moduleDir: import.meta.dirname })
}
