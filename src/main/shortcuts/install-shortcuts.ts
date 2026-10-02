// Puts the shortcuts on every view the process makes, and owns the
// application menu. One listener on `web-contents-created` reaches the chrome
// view, every tab (repartitioned, adopted from a popup, or moved), the
// popovers and the internal pages without any of them being wired one by one.
import { ipcMain, Menu } from 'electron'
import type { App, WebContents } from 'electron'
import { INTERNAL_EVENT_CHANNEL } from '../channels.js'
import { appTabViews } from '../shell/tab-partition.js'
import type { WindowRegistry } from '../shell/window-registry.js'
import { buildAppMenuTemplate } from './app-menu.js'
import { attachShortcuts } from './dispatcher.js'
import type { ExtensionKeys } from './dispatcher.js'
import type { CommandBus } from './command-bus.js'
import type { CommandId } from './commands.js'
import { defaultKeyStillBound, installPageKeyIpc } from './page-key-ipc.js'
import type { ShortcutService } from './shortcut-service.js'

/** Extensions' command keys, which start answering once the saved shortcuts are read: this is that moment. */
export interface ExtensionKeysSource extends ExtensionKeys {
  ready: (env: { shortcuts: ShortcutService, windows: WindowRegistry }) => void
}

export function installShortcuts (app: Pick<App, 'on'>, service: ShortcutService, windows: WindowRegistry, commands: CommandBus, extensionKeys?: ExtensionKeysSource): void {
  extensionKeys?.ready({ shortcuts: service, windows })
  const host = {
    extensionKeys,
    windowFor: (contents: WebContents) => {
      // A view in no window of ours (the verifier's, an offscreen context) has no shortcuts.
      const owner = windows.findOwner(contents) ?? windows.focused()
      if (owner === undefined) return null
      const tabId = owner.tabs.findTabIdByWebContents(contents)
      const view = tabId === null ? undefined : owner.tabs.record(tabId)?.view
      return { suspended: owner.shortcutsSuspended(), isAppTab: view !== undefined && appTabViews.has(view), run: (id: CommandId) => { commands.run(id, owner) }, alive: () => !owner.window.isDestroyed() }
    },
    recorded: (contents: WebContents, outcome: unknown) => {
      if (!contents.isDestroyed()) contents.send(INTERNAL_EVENT_CHANNEL, { topic: 'shortcuts.recorded', payload: outcome })
    }
  }
  installPageKeyIpc(ipcMain, {
    stillBound: (id) => defaultKeyStillBound(service, id),
    tabOf: (contents) => {
      const owner = windows.findOwner(contents)
      if (owner === undefined) return null
      const tabId = owner.tabs.findTabIdByWebContents(contents)
      const view = tabId === null ? undefined : owner.tabs.record(tabId)?.view
      return { active: owner.tabs.activeWebContents() === contents, isAppTab: view !== undefined && appTabViews.has(view), suspended: owner.shortcutsSuspended(), run: (id) => { commands.run(id, owner) } }
    }
  })
  app.on('web-contents-created', (_event, contents) => {
    // A page in the window; not DevTools, a webview's guest or a background page.
    if (contents.getType() === 'window') attachShortcuts(contents, service, host)
  })

  // The menu names the commands and their keys; it runs them on the window in use.
  const run = (id: CommandId): void => {
    const owner = windows.focused()
    if (owner !== undefined) commands.run(id, owner)
  }
  const refreshMenu = (): void => { Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate(service, run) ?? [])) }
  if (service.platform === 'darwin') {
    refreshMenu()
    service.onChange(refreshMenu)
  } else {
    Menu.setApplicationMenu(null)
  }
}
