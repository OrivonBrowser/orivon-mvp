// The real ConsentPrompt (./request-grant.ts) for item 4.2 (docs/planning/
// unattended-build-queue.md) -- replaces #79-#82's plain dialog.
// showMessageBox placeholder wholesale, per that file's own header ("meant
// to be replaced wholesale, not refined"). Still a native message box: no
// new dependency, no custom window (Rule 8; "no UI framework" for this
// lane) -- but the CONTENT is now a real, rendered manifest
// (grant-prompt-render.ts), not a raw capability identifier, and
// `type: 'warning'` swaps the OS's own icon for an unlimited grant, a
// second, non-text signal alongside the literal marker in the message.
//
// Fetches the manifest itself rather than widening ConsentPrompt's own
// signature: request-grant.ts's header says its logic should not need to
// change for this file's replacement, and it already fetched this same
// manifest once, for decideGrantRequest, before ever calling consent().

import { dialog } from 'electron'
import type { MessageBoxOptions } from 'electron'
import { describeGrantRequest } from './grant-prompt-render.js'
import type { Broker } from '../broker/broker-contracts.js'
import type { ConsentPrompt } from './request-grant.js'

/**
 * Builds the real ConsentPrompt request-grant-subsystem.ts wires in.
 * Fails closed (denies, no dialog shown) if the manifest cannot be read
 * back -- it should always be readable here, since request-grant.ts only
 * calls consent() after its own fetch of the same manifest already
 * succeeded, but a person must never be asked to approve a grant this
 * dialog cannot actually describe.
 */
export function createGrantPrompt (broker: Broker): ConsentPrompt {
  return async (origin, capability, patterns) => {
    let manifest
    try {
      manifest = await broker.app.manifest(origin)
    } catch {
      return false
    }

    const content = describeGrantRequest(origin, manifest, capability, patterns)
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
