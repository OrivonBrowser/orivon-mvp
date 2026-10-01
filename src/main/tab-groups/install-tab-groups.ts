// A tab that leaves its window for another leaves its group, which is only that window's.
import type { ShellInstaller } from '../shell/shell-installers.js'

export const installTabGroups: ShellInstaller = {
  name: 'tab-groups',
  install: (_app, services) => {
    services.tabLifecycle.subscribe({
      tabClosing: ({ reason, record }) => {
        if (reason === 'moved') record.groupId = null
      }
    })
  }
}
