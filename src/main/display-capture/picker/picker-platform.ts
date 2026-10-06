// What this system is, as far as the picker's segments care. Tied to Electron: Chromium writes the ozone platform it
// resolved back into its `ozone-platform` switch, and `isLocalPointer` is the shell's one reading of it as Wayland.
import { app, systemPreferences } from 'electron'
import { isLocalPointer } from '../../shell/local-pointer.js'
import type { PickerPlatform } from './picker-model.js'

export function detectPlatform (os: NodeJS.Platform = process.platform): PickerPlatform {
  return {
    os,
    wayland: os === 'linux' && isLocalPointer(app.commandLine.getSwitchValue('ozone-platform')),
    screenDenied: os === 'darwin' && screenStatus() === 'denied'
  }
}

function screenStatus (): string {
  try {
    return systemPreferences.getMediaAccessStatus('screen')
  } catch {
    return 'unknown'
  }
}
