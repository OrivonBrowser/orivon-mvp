// The question before developer tools open on an app that holds permissions.
import { dialog } from 'electron'
import type { BaseWindow } from 'electron'

const OPEN = 0
const CANCEL = 1

/** True when the person chose to open them. The main process waits while the question is open. */
export function confirmOpenDevTools (window: BaseWindow, origin: string): boolean {
  if (window.isDestroyed()) return false
  const choice = dialog.showMessageBoxSync(window, {
    type: 'warning',
    buttons: ['Open developer tools', 'Cancel'],
    defaultId: CANCEL,
    cancelId: CANCEL,
    noLink: true,
    message: `Open developer tools for ${origin}?`,
    detail: 'Anything typed into their console runs as this app, with everything it has been allowed to do. Only run what you wrote or understand.'
  })
  return choice === OPEN
}
