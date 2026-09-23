// The "Leave this page?" question a page's beforeunload handler asks for.
// Chromium raises it only after the person has interacted with the page, so
// a page cannot hold anyone on it who never touched it.
import { dialog, type BaseWindow } from 'electron'

const LEAVE = 0
const STAY = 1

/** True to leave anyway. Synchronous because Electron settles the unload
 * from `will-prevent-unload`'s own return, with no callback to answer
 * later; the main process waits while the question is open. */
export function confirmLeavePage (window: BaseWindow): boolean {
  if (window.isDestroyed()) return true
  const choice = dialog.showMessageBoxSync(window, {
    type: 'question',
    buttons: ['Leave', 'Stay'],
    defaultId: LEAVE,
    cancelId: STAY,
    noLink: true,
    message: 'Leave this page?',
    detail: 'Changes you made may not be saved.'
  })
  return choice === LEAVE
}
