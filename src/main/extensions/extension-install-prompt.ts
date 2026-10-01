// The real InstallPrompt (./install-runner.ts): the install question, drawn in
// the panel of the tab it belongs to. This file only shows the words
// `describeExtensionInstall` (src/broker/policy/extension-manifest.ts)
// composed, it never composes them itself.
import { askQuestion } from '../shell/question/ask-question.js'
import type { ExtensionInstallDescription } from '../../broker/policy/extension-manifest.js'
import type { InstallPrompt } from './install-runner.js'

/** Builds the real InstallPrompt install-runner.ts's callers wire in.
 * Default Cancel, same as every other consent question in this family
 * (`../consent/install-consent-prompt.ts`'s own doc): dismissing a question
 * must never install more than doing nothing would. The words name the
 * extension, never the page the person is on, so the page under the panel
 * cannot be mistaken for who is asking. */
export function createExtensionInstallPrompt (): InstallPrompt {
  return async (description: ExtensionInstallDescription, where) => {
    const { response } = await askQuestion({ contents: where?.contents }, {
      kind: 'consent',
      warning: description.warning,
      buttons: [description.accept ?? 'Add extension', 'Cancel'],
      cancelId: 1,
      guarded: [0],
      focus: 'dialog',
      title: description.title,
      message: description.message,
      detail: description.detail
    })
    return response === 0
  }
}
