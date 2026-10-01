// The one `media` request the gate grants: an extension's own
// `chrome.tabCapture` capture of the tab it was granted. Every other
// `media` request (a page asking for camera or microphone) is not decided here.
import type { WebContents } from 'electron'
import { extensionIdFromChromeExtensionOrigin, isTabCaptureMediaRequestAllowed, markTabCaptureGrantConsumed } from './tab-capture-grants.js'

/**
 * The SAME "is this tab a granted app" question
 * `vendor/.../tab-capture.ts`'s own `setTabCaptureAppRefusalCheck` answers
 * at mint time and on navigation -- repeated here because a mint-time
 * refusal alone leaves a gap this handler is the last line against: a tab
 * refused at `getMediaStreamId()` time never reaches here at all, but a tab
 * that was NOT a granted app at mint, then navigates to one, keeps its
 * already-live grant (`tab-capture-grants.ts` has no idea a navigation
 * happened) until either `tab-capture.ts`'s own `did-navigate` re-check
 * fires or -- if that re-check is ever slower than the extension's own
 * `getUserMedia('tab')` call -- this handler is asked to actually hand out
 * the stream. Checking `contents` here is exactly right for this call
 * shape: `allowTabCaptureMediaRequest`'s doc below says `contents` IS the
 * captured tab for a tab-capture request, so this is the tab at the moment access is
 * actually granted, not at some earlier moment. Wired from
 * `../extensions/extension-host.ts`, alongside the vendored library's own
 * identical registration -- two call sites, one predicate.
 */
type MediaAppRefusalCheck = (contents: WebContents) => boolean
let gMediaAppRefusalCheck: MediaAppRefusalCheck | undefined
export function setTabCaptureMediaAppRefusalCheck (check: MediaAppRefusalCheck): void {
  gMediaAppRefusalCheck = check
}

/**
 * `media` stays denied by default (a page asking for camera/microphone) --
 * this is the one carve-out, for chrome.tabCapture's own `getUserMedia({
 * audio: { mandatory: { chromeMediaSource: 'tab', ... } } })` call. Measured
 * directly (docs/planning's tabCapture/offscreen probe): the request
 * handler's OWN `contents` argument is the CAPTURED TAB's webContents, not
 * the requester's, for this exact call shape -- only `details.securityOrigin`
 * names the requesting `chrome-extension://` origin.
 *
 * `contents` is exactly the fact that makes this carve-out
 * safe to check tightly: a real device request -- `getUserMedia({ audio:
 * true, video: true })`, called by the extension on its OWN page to reach
 * the real microphone/camera -- hands `contents` as the CALLING page
 * itself, never the captured tab, and carries `mediaTypes` naming what it
 * asked for (`['audio','video']`), where a tab-capture request's own
 * `mediaTypes` measures empty (`[]`). `isTabCaptureMediaRequestAllowed`
 * checks `contents.id` against the exact tab the extension's own
 * `getMediaStreamId()` call named, `mediaTypes` empty, AND
 * `details.isMainFrame`. Without the first two, an extension holding one
 * live tabCapture grant (minted once, for whichever tab it was invoked on)
 * could call `getUserMedia({audio:true,video:true})` on its own page and
 * silently receive the real mic and camera. `isMainFrame` closes a
 * SEPARATE gap those two cannot: `getUserMedia({mandatory:
 * {chromeMediaSource:'desktop'}})` ALSO measures `mediaTypes: []`, and a
 * web-accessible extension page injected as an `<iframe>` into the SAME
 * tab a grant names shares that tab's own `contents.id` (a page and its
 * iframes are one `WebContents`) -- `tab-capture-grants.ts`'s own doc has
 * the full measurement.
 *
 * Allowing the REQUEST (never the check) is also the one real signal that a
 * genuine `getUserMedia('tab')` call is in flight for this grant -- marked
 * consumed on the way out, so `tab-capture.ts`'s own safety net stops
 * treating this (extension, tab) pair as "maybe never redeemed" the moment
 * Electron actually asks permission for it, however long the real capture
 * goes on to run. MEASURED why the check handler must never mark this, and
 * must never allow `'media'` at all: `setPermissionCheckHandler` fires
 * repeatedly and speculatively for a `chrome-extension://` page (camera/
 * microphone availability probing this library's own preload, or
 * Chromium's own media-device enumeration) with no `getUserMedia()` call
 * behind it at all, and carries no captured-tab identity to check against
 * even when it does correspond to a real call -- `wc`/`origin` there are
 * the REQUESTER's own, and `details.mediaType` (singular) cannot
 * distinguish "tab capture asking for audio" from "a device asking for
 * audio" the way the request handler's `mediaTypes` (plural, an exact
 * list) can. `setPermissionRequestHandler` fires only for an actual,
 * one-time media-access attempt with the tab identity this file needs;
 * that is the one Chromium contract this file leans on, so `'media'` is
 * refused outright in the check handler.
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
  // Re-run against `contents` -- the captured tab, for this call
  // shape -- one more time, right before actually granting: see
  // setTabCaptureMediaAppRefusalCheck's own doc for why a mint-time-only
  // check is not enough.
  if (gMediaAppRefusalCheck?.(contents) === true) return false
  const extensionId = extensionIdFromChromeExtensionOrigin(origin)
  if (extensionId !== undefined) markTabCaptureGrantConsumed(extensionId, contents.id, now)
  return true
}
