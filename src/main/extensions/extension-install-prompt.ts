// The real InstallPrompt (./install-runner.ts) -- a plain
// `dialog.showMessageBox`, in the shape
// `../consent/install-consent-prompt.ts` already uses: this file only
// shows the words `describeExtensionInstall` (src/broker/policy/
// extension-manifest.ts) composed, it never composes them itself.

import { dialog } from 'electron'
import type { MessageBoxOptions } from 'electron'
import type { ExtensionInstallDescription } from '../../broker/policy/extension-manifest.js'
import type { InstallPrompt } from './install-runner.js'

/** Builds the real InstallPrompt install-runner.ts's callers wire in.
 * Default Cancel, same as every other consent dialog in this family
 * (`../consent/install-consent-prompt.ts`'s own doc): dismissing a dialog
 * must never install more than doing nothing would. */
export function createExtensionInstallPrompt (): InstallPrompt {
  return async (description: ExtensionInstallDescription) => {
    const options: MessageBoxOptions = {
      type: description.warning ? 'warning' : 'question',
      buttons: ['Add extension', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: description.title,
      message: description.message,
      detail: description.detail
    }
    const { response } = await dialog.showMessageBox(options)
    return response === 0
  }
}
