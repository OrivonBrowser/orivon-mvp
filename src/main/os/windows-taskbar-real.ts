// The Windows taskbar hook wired to the real process, for WINDOW_HOOKS.
import { app } from 'electron'
import { windowsTaskbarHook } from './windows-taskbar.js'

export const windowsTaskbar = windowsTaskbarHook(() => ({
  platform: process.platform,
  source: { execPath: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged, appImage: undefined, env: {} }
}))
