// The plain, unstyled ConsentPrompt (./request-grant.ts) that ships with
// item 4.1 -- a native `dialog.showMessageBox`, nothing rendered, no manifest
// laid out, no attempt at making a wide pattern READ as wide (that is item
// 4.2's own exit criterion: "a narrow declaration and an unlimited one are
// unmistakably different to look at", explicitly not this file's job --
// docs/planning/unattended-build-queue.md's own "do not design the
// user-facing dialog" for this item). This function is meant to be replaced
// wholesale, not refined.

import { dialog } from 'electron'
import type { MessageBoxOptions } from 'electron'
import type { ConsentPrompt } from './request-grant.js'

export const showGrantPrompt: ConsentPrompt = async (origin, capability, patterns) => {
  // `exactOptionalPropertyTypes` (tsconfig.json) refuses `detail: undefined`
  // outright -- the key must be OMITTED, not present with an undefined
  // value, when there is nothing to say.
  const options: MessageBoxOptions = {
    type: 'question',
    buttons: ['Allow', 'Deny'],
    defaultId: 1,
    cancelId: 1,
    message: `${origin} is requesting: ${capability}`,
    ...(patterns.length > 0 ? { detail: `Patterns: ${patterns.join(', ')}` } : {})
  }
  const { response } = await dialog.showMessageBox(options)
  return response === 0
}
