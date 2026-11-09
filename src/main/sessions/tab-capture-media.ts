// The one `media` request the gate grants: an extension's own
// `chrome.tabCapture` capture of the tab it was granted. Every other
// `media` request (a page asking for camera or microphone) is not decided here.
import type { WebContents } from 'electron'
import { extensionIdFromChromeExtensionOrigin, isTabCaptureMediaRequestAllowed, markTabCaptureGrantConsumed } from './tab-capture-grants.js'

/**
 * `media` stays denied by default; this is the one carve-out, for the `getUserMedia` call
 * `chrome.tabCapture` itself makes. The request handler's `contents` is the CAPTURED tab, never
 * the requester, and only `details.securityOrigin` names the extension, so the grant must name
 * exactly that tab, `mediaTypes` must be empty and the request must be from the main frame.
 * Allowing the request, never the check, is what marks the grant consumed. See README.md's Design
 * notes for why each of the three conditions is there and why the check handler never allows `media`.
 */
export function allowTabCaptureMediaRequest (contents: WebContents, details: object | undefined): boolean {
  const origin = details !== undefined && 'securityOrigin' in details && typeof details.securityOrigin === 'string'
    ? details.securityOrigin
    : undefined
  const mediaTypes = details !== undefined && 'mediaTypes' in details && Array.isArray(details.mediaTypes)
    ? details.mediaTypes as string[]
    : undefined
  // Defaults to `false` (refuse) when absent, never `true`: `isMainFrame`
  // is a documented field of every real MediaAccessPermissionRequest
  // (electron.d.ts), so its absence here means `details` itself is not the
  // shape this carve-out expects, and the safe reading of "not confirmed
  // main-frame" is "refuse it".
  const isMainFrame = details !== undefined && 'isMainFrame' in details && details.isMainFrame === true
  const now = Date.now()
  const allowed = isTabCaptureMediaRequestAllowed(origin, contents.id, mediaTypes, isMainFrame, now)
  if (!allowed) return false
  const extensionId = extensionIdFromChromeExtensionOrigin(origin)
  if (extensionId !== undefined) markTabCaptureGrantConsumed(extensionId, contents.id, now)
  return true
}
