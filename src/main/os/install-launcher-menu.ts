// Puts "New window" and "New private window" in the menu the system draws for Orivon's icon: the taskbar's jump list
// on Windows, the dock's menu on macOS. On Linux the installed package's desktop entry carries them
// (electron-builder.yml). Only the default profile offers them: a task starts the default profile's browser, and a
// kiosk or a private session has no business adding entries for it.
import { Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import type { ShellInstaller } from '../shell/shell-installers.js'
import { appUserModelId, launcherTasks } from './launcher-tasks.js'

type BuildMenu = (items: MenuItemConstructorOptions[]) => Electron.Menu

export function launcherMenuInstaller (platform: NodeJS.Platform, buildMenu: BuildMenu): ShellInstaller {
  return {
    name: 'launcher-menu',
    install: (app, services, _ctx, runtime) => {
      // Before any window exists, and for every profile: the taskbar groups a process's windows under this id.
      if (platform === 'win32') app.setAppUserModelId(appUserModelId(app.isPackaged))
      if (runtime.profileId !== 'default' || runtime.isPrivate || services.kiosk) return
      if (platform === 'win32') {
        if (!app.setUserTasks(launcherTasks(runtime.source))) console.error('[os] the taskbar menu could not be set')
      } else if (platform === 'darwin') {
        app.dock?.setMenu(buildMenu([
          { label: 'New Window', click: () => { services.commands.openWindow({}) } },
          { label: 'New Private Window', click: () => { services.profiles.openPrivate() } }
        ]))
      }
    }
  }
}

export const installLauncherMenu = launcherMenuInstaller(process.platform, (items) => Menu.buildFromTemplate(items))
