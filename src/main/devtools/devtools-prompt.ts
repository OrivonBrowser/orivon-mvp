// The question before developer tools open on an app that holds permissions.
import type { WebContents } from 'electron'
import { askQuestion } from '../shell/question/ask-question.js'

const OPEN = 0
const CANCEL = 1

/** True when the person chose to open them. Drawn in the tab being inspected; a new page in the tab, or the tab closing, answers no. */
export async function confirmOpenDevTools (contents: WebContents, origin: string): Promise<boolean> {
  const { response } = await askQuestion({ contents }, {
    kind: 'consent',
    warning: true,
    buttons: ['Open developer tools', 'Cancel'],
    cancelId: CANCEL,
    guarded: [OPEN],
    focus: 'dialog',
    message: `Open developer tools for ${origin}?`,
    detail: 'Anything typed into their console runs as this app, with everything it has been allowed to do. Only run what you wrote or understand.'
  }, { endOnNavigation: true })
  return response === OPEN
}
