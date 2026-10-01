// Wires what moves the keyboard: a change to the caret setting reaches every open tab. The pane keys need no
// wiring of their own; they are commands (../shortcuts/run-command.ts).
import type { ShellInstaller } from '../shell/shell-installers.js'
import { CARET_SETTING } from './caret.js'
import { applyCaret } from './caret-runner.js'

export const installFocus: ShellInstaller = {
  name: 'focus',
  install: (_app, services) => {
    services.settings.onChange(({ key }) => { if (key === CARET_SETTING) applyCaret(services) })
  }
}
