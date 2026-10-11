// Wires what moves the keyboard: a change to the caret setting reaches every open tab, and on macOS contents that
// close while holding the keyboard give it to their window's chrome first (closing-focus.ts). The pane keys need no
// wiring of their own; they are commands (../shortcuts/run-command.ts).
import type { App } from 'electron'
import type { ShellInstaller } from '../shell/shell-installers.js'
import type { WindowRegistry } from '../shell/window-registry.js'
import { CARET_SETTING } from './caret.js'
import { applyCaret } from './caret-runner.js'
import { handOffFocusOnClose } from './closing-focus.js'

export const installFocus: ShellInstaller = {
  name: 'focus',
  install: (app, services) => {
    services.settings.onChange(({ key }) => { if (key === CARET_SETTING) applyCaret(services) })
    wireClosingFocus(app, services.windows)
  }
}

/** On macOS, every web contents made from now on gives the keyboard to its window's chrome when it closes holding it. */
export function wireClosingFocus (app: Pick<App, 'on'>, windows: Pick<WindowRegistry, 'findOwner'>, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'darwin') return
  app.on('web-contents-created', (_event, contents) => {
    handOffFocusOnClose(contents, (closing) => windows.findOwner(closing)?.chrome.webContents)
  })
}
