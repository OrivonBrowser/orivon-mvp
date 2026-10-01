// The real ConsentPrompt (./request-grant.ts): "may this app hold this
// capability?", asked in the panel of the tab whose page asked, with the
// manifest rendered by grant-prompt-render.ts instead of a raw capability
// name. An unlimited grant is drawn in the warning style, a second signal
// beside the marker in the message.
//
// It fetches the manifest itself rather than widening ConsentPrompt's
// signature: request-grant.ts already read the same manifest once, for
// decideGrantRequest, before calling consent().

import { describeGrantRequest } from './grant-prompt-render.js'
import { formatOriginForDisplay } from './grant-prompt-origin.js'
import type { Broker } from '../../broker/broker-contracts.js'
import { askCaller, holdCaller } from './ask-caller.js'
import type { ConsentPrompt } from './request-grant.js'
import type { ScoreLevel } from '../../trust/website-level.js'

/**
 * Builds the real ConsentPrompt request-grant-subsystem.ts wires in.
 * Fails closed (denies, no dialog shown) if the manifest cannot be read
 * back -- it should always be readable here, since request-grant.ts only
 * calls consent() after its own fetch of the same manifest already
 * succeeded, but a person must never be asked to approve a grant this
 * dialog cannot actually describe.
 *
 * `levelOverrideFor` defaults to never overriding (ADR-0037); the real
 * `../dev/score-levels.js` function is wired in at
 * `./request-grant-subsystem.ts`. `extensionsOnSite` (the extensions disclosure,
 * docs/planning/extensions-exploration.md) is the same shape, wired to the
 * real `../extensions/site-reach-runner.js` at the same place, and
 * defaults to always naming none.
 */
export function createGrantPrompt (
  broker: Broker,
  levelOverrideFor: (origin: string) => ScoreLevel | undefined = () => undefined,
  extensionsOnSite: (origin: string) => Promise<readonly string[]> = async () => []
): ConsentPrompt {
  return async (origin, capability, patterns, caller, abandoned) => {
    let manifest
    try {
      manifest = await broker.app.manifest(origin)
    } catch {
      return false
    }

    const names = await extensionsOnSite(origin)
    // The page that asked may have navigated the tab elsewhere, or closed
    // it, while the manifest and extensions above were being read -- never
    // show a dialog for a page the person is no longer looking at
    // (request-grant.ts's own `DialogCaller` doc).
    if (caller !== undefined && !caller.stillOn(origin)) return false

    const content = describeGrantRequest(origin, manifest, capability, patterns, levelOverrideFor(origin), names)
    // The tab stays where it is until the person has answered: an answer
    // given to a page that has become another page would grant that page.
    const release = holdCaller(caller)
    try {
      const { response } = await askCaller(caller, {
        kind: 'consent',
        origin: formatOriginForDisplay(origin),
        warning: content.warning,
        title: content.title,
        message: content.message,
        detail: content.detail,
        buttons: ['Allow', 'Deny'],
        cancelId: 1,
        guarded: [0],
        focus: 'dialog'
      }, abandoned)
      return response === 0
    } finally {
      release()
    }
  }
}
