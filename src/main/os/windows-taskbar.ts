// A run from source on Windows gives each window's taskbar button its own identity and the command that starts it
// again: without them the button belongs to Electron's own program and pins as that. An installed program is
// identified by the installer's shortcut, and sets only the process's id (install-launcher-menu.ts).
import type { PeerSource } from '../launch/peer-spawn.js'
import type { WindowHook } from '../shell/window-hooks.js'
import { appUserModelId, relaunchCommand } from './launcher-tasks.js'

export interface TaskbarFacts {
  readonly platform: NodeJS.Platform
  readonly source: PeerSource
}

export function windowsTaskbarHook (facts: () => TaskbarFacts): WindowHook {
  return {
    name: 'windows-taskbar',
    opened: ({ window }) => {
      const { platform, source } = facts()
      if (platform !== 'win32' || source.packaged) return
      window.window.setAppDetails({
        appId: appUserModelId(false),
        relaunchCommand: relaunchCommand(source),
        relaunchDisplayName: 'Orivon',
        appIconPath: source.execPath
      })
    }
  }
}
