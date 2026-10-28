// Registered in `./shell-installers.ts`: tells the routes what the shell's tabs know (the choice of the tab a request comes from, the
// tunnel a tab that shows a website sends it through), which `../route/` must not read off the tabs itself (ADR-0101).
import { webContents } from 'electron'
import type { ShellInstaller } from './shell-installers.js'
import { kindShowing, tabsWithChoice } from './tab-tunnel-choice.js'
import { exposeTabTunnelForTests } from './tab-tunnel-test-hook.js'
import { setTabTunnelSource } from '../route/tab-tunnel.js'

export const installTabTunnel: ShellInstaller = {
  name: 'tab-tunnel',
  install: (_app, services) => {
    setTabTunnelSource({
      choiceOfContents: (webContentsId) => {
        const contents = webContents.fromId(webContentsId)
        if (contents === undefined || contents.isDestroyed()) return undefined
        const found = services.windows.findTab(contents)
        return found?.window.tabs.record(found.tabId)?.tunnelChoice
      },
      kindShowing: (origin) => kindShowing(tabsWithChoice(services.windows), origin)
    })
    exposeTabTunnelForTests({
      set: (tabId, choice) => {
        const owner = services.windows.all().find((window) => window.tabs.record(tabId) !== undefined)
        owner?.tabs.setTunnelChoice(tabId, choice)
        return owner !== undefined
      },
      choiceOf: (tabId) => services.windows.all().map((window) => window.tabs.record(tabId)?.tunnelChoice).find((choice) => choice !== undefined)
    })
  }
}
