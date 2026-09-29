// A page or worker of one loaded extension could otherwise call any
// crx-msg handler under ANOTHER loaded extension's identity: the library
// reads `extensionId` from the message itself (renderer/index.ts's
// invokeExtension passes `chrome.runtime?.id`, but nothing stops a
// compromised or malicious extension page from calling
// `window.electron.invokeExtension('someone-elses-id', 'tabs.create', ...)`
// directly), and every permission check in onExtensionMessage
// (router.ts) trusts that value. senderMatchesClaimedExtensionId derives
// the REAL id from the sender itself -- the frame's or worker's own
// `chrome-extension://<id>/` URL, which a page cannot forge -- so
// extension-host.ts can refuse a message that names a different one.
// Vendored patch: UPSTREAM.md. No `orivon:crx-extensions-router` import
// here (unlike extension-host.ts, which wires this in): that virtual
// specifier only resolves under electron.vite's alias, not this file's own
// unit test.
import { extensionIdFromScope } from './extension-sw-preload-recovery.js'

interface FrameMessageEvent { type: 'frame', sender: { getURL: () => string } }
interface ServiceWorkerMessageEvent { type: 'service-worker', serviceWorker: { scope: string } }
export type MessageEvent = FrameMessageEvent | ServiceWorkerMessageEvent

/** True unless the message names an extension id that is not the sender's
 * own. A message that names no id (`claimedExtensionId === undefined`,
 * legitimate for a handler with `extensionContext: false`) is never
 * refused here -- there is nothing to spoof. A sender whose own URL is not
 * `chrome-extension://<id>/...` can never satisfy a named claim, so a
 * message naming an id from an unrecognizable sender is refused too. */
export function senderMatchesClaimedExtensionId (event: MessageEvent, claimedExtensionId: string | undefined): boolean {
  if (claimedExtensionId === undefined) return true
  const senderUrl = event.type === 'service-worker' ? event.serviceWorker.scope : event.sender.getURL()
  const senderId = extensionIdFromScope(senderUrl)
  return senderId !== undefined && senderId === claimedExtensionId
}
