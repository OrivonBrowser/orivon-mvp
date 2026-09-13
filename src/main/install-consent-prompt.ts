// The real InstallConsentPrompt (./install-consent.ts) for d-0025 -- one
// native dialog for a manifest's whole declared capability set, never
// request-grant-prompt.ts's per-capability dialog shown once per capability.
// Same "no new dependency, no custom window" stance that file's header
// gives (Rule 8): a plain `dialog.showMessageBox`, its `type` swapped to
// 'warning' the moment any declared capability is unlimited (A100), with
// the actual words built by ./grant-prompt-render.ts's
// `describeInstallConsent` -- this file only shows them, never composes
// them, matching request-grant-prompt.ts's own split.

import { dialog } from 'electron'
import type { MessageBoxOptions } from 'electron'
import { describeInstallConsent } from './grant-prompt-render.js'
import type { InstallConsentPrompt } from './install-consent.js'

/** Builds the real InstallConsentPrompt ./app-install-subsystem.ts wires in. */
export function createInstallConsentPrompt (): InstallConsentPrompt {
  return async (origin, manifest, capabilities) => {
    const content = describeInstallConsent(origin, manifest, capabilities)
    const options: MessageBoxOptions = {
      type: content.warning ? 'warning' : 'question',
      buttons: ['Allow', 'Deny'],
      defaultId: 1,
      cancelId: 1,
      title: content.title,
      message: content.message,
      detail: content.detail
    }
    const { response } = await dialog.showMessageBox(options)
    return response === 0
  }
}
