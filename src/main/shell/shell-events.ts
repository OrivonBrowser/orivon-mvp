import { SHELL_EVENT_CHANNEL } from '../channels.js'
import type { ShellWindow } from './window-registry.js'

/** What main asks the chrome to do by itself, over SHELL_EVENT_CHANNEL: focus the address bar, draw or
 * clear the cross-window drop mark, or hand a payload to one chrome module. The preload and the chrome
 * renderer both take this type, so an event added here reaches them without a second declaration. */
export type ShellEvent =
  | { type: 'focusAddress' }
  | { type: 'dragMark', index: number }
  | { type: 'dragMarkClear' }
  | { type: 'module', module: string, payload: unknown }

/** Sends `payload` to the chrome module called `module` (`ChromeModule.event`), if the window still has a chrome. */
export function sendChromeEvent (window: ShellWindow, module: string, payload: unknown): void {
  const contents = window.chrome.webContents
  if (contents.isDestroyed()) return
  const event: ShellEvent = { type: 'module', module, payload }
  contents.send(SHELL_EVENT_CHANNEL, event)
}
