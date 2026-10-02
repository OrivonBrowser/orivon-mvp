import { ipcRenderer } from 'electron'
import { PAGE_KEY_CHANNEL } from '../main/channels.js'
import { isFindChord } from './find-chord.js'

/** Duplicated from expose-fetch-route.ts rather than imported -- src/preload/README.md forbids importing anything under src/main/ except ./channels.ts, and this is not a channel. */
const APP_TAB_FLAG = '--orivon-app-tab'

/**
 * In a registered app's tab the browser's own keys go to the page first, so an app with its own find keeps it.
 * A Ctrl+F nobody took (not `defaultPrevented` once every handler has run) would otherwise do nothing at all,
 * so this asks main to open the browser's find bar. Exposes nothing to the page; main decides whether to act.
 */
export function installPageKeys (): void {
  if (!process.argv.includes(APP_TAB_FLAG) || window.top !== window) return
  // Capture phase, so a page that stops the event from bubbling still reports it: only `defaultPrevented` is the page's answer.
  window.addEventListener('keydown', (event) => {
    if (!isFindChord(event, process.platform)) return
    // The page's own handlers run after this one: read the verdict once they have all run.
    setTimeout(() => {
      if (!event.defaultPrevented) ipcRenderer.send(PAGE_KEY_CHANNEL, { command: 'find.open' })
    }, 0)
  }, true)
}
