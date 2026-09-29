// A page or worker of one loaded extension could otherwise call any
// crx-msg handler under ANOTHER loaded extension's identity: the library
// reads `extensionId` from the message itself (renderer/index.ts's
// invokeExtension passes `chrome.runtime?.id`, but nothing stops a page
// from calling `invokeExtension('someone-elses-id', 'tabs.create', ...)`
// directly), and every permission check in onExtensionMessage (router.ts)
// trusts that value. senderMatchesClaimedExtensionId derives the REAL id
// from the sender itself -- the SENDING frame's own
// `chrome-extension://<id>/` URL, never the top-level page's (an
// extension's page can embed another's in an iframe; its messages check
// against ITS id) -- so extension-host.ts can refuse a mismatch.
//
// A missing or non-string id is refused too: crx-msg-remote (the only
// legitimate no-context caller, restricted by router.ts's own
// gRemoteMessageSenderCheck to the chrome view) never consults this check
// at all, and every crx-msg/crx-add-listener/crx-remove-listener caller
// names its own id. Without this, a page of any loaded extension could call
// crx-msg with no id and reach a handler meant only for crx-msg-remote,
// impersonating whatever extension its own arguments named.
// Vendored patch: UPSTREAM.md. No `orivon:crx-extensions-router` import
// here (unlike extension-host.ts): that virtual specifier resolves only
// under electron.vite's alias, not this file's own unit test.
import { extensionIdFromScope } from './extension-sw-preload-recovery.js'

interface FrameMessageEvent { type: 'frame', senderFrame: { url: string } | null }
interface ServiceWorkerMessageEvent { type: 'service-worker', serviceWorker: { scope: string } }
export type MessageEvent = FrameMessageEvent | ServiceWorkerMessageEvent

/** `frame.url`, or undefined when the frame is unavailable: `null` (already
 * destroyed by the time Electron reads `event.senderFrame`), or destroyed
 * between that read and this one (`.url` itself throws in that window). */
function frameUrl (frame: { url: string } | null): string | undefined {
  if (frame === null) return undefined
  try {
    return frame.url
  } catch {
    return undefined
  }
}

/** True only when the message names its OWN sender's extension id. A
 * missing or non-string id is refused (this doc's own header says why), and
 * so is any claim from a sender whose own URL is not
 * `chrome-extension://<id>/...`, or whose frame is missing or destroyed. */
export function senderMatchesClaimedExtensionId (event: MessageEvent, claimedExtensionId: string | undefined): boolean {
  if (typeof claimedExtensionId !== 'string' || claimedExtensionId.length === 0) return false
  const senderUrl = event.type === 'service-worker' ? event.serviceWorker.scope : frameUrl(event.senderFrame)
  if (senderUrl === undefined) return false
  const senderId = extensionIdFromScope(senderUrl)
  return senderId !== undefined && senderId === claimedExtensionId
}
