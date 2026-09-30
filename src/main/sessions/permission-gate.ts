// Deny-by-default gate for every Chromium permission a web page can ask
// for -- camera/microphone, clipboard reads, geolocation, MIDI, among
// others. ALLOWED_PERMISSIONS and `isAllowed` say which names pass, and
// `openExternal` and `notifications` pass only when the person says yes.
// Electron's own documented default, when no handler is installed on a
// session, is to APPROVE. See ./README.md's Design notes for why this is
// wired via `app.on('session-created', ...)` rather than at any one
// session's own construction site -- that placement is load-bearing, not a
// style choice, and moving it back "for clarity" reopens the gap.
import { join } from 'node:path'
import { app, session, type Session, type WebContents } from 'electron'
import type { Subsystem } from '../registry.js'
import { noteExclusiveAccess, type ExclusiveAccess } from '../shell/exclusive-access-notice.js'
import { confirmExternalLink } from '../shell/external-link-prompt.js'
import { askNotificationPermission } from '../shell/notification-prompt.js'
import { windowShowing } from '../shell/showing-window.js'
import { createExternalLinks } from './external-links.js'
import { NotificationDecisions } from './notification-decisions.js'
import { createSiteNotifications } from './site-notifications.js'
import { extensionIdFromChromeExtensionOrigin, isTabCaptureMediaRequestAllowed, markTabCaptureGrantConsumed } from './tab-capture-grants.js'

/**
 * Permissions this browser allows outright; `isAllowed` below adds the one
 * conditional name. The grant ledger governs `orivon.*` capabilities, not
 * Chromium's own, so a name belongs here only when the web platform's own
 * gating is what makes it safe -- never because an app asked for it.
 * ./README.md says which clause of that rule each name meets. ADR-0022
 * argues clipboard write, ADR-0024 one file, ADR-0025 fullscreen, ADR-0026
 * pointer and keyboard lock; ADR-0027 and ADR-0028 the two names the person
 * is asked about, external links and notifications.
 *
 * `clipboard-sanitized-write` lets a page call
 * `navigator.clipboard.writeText()`. Chromium still requires transient
 * user activation and a focused document, so the person has to have just
 * acted in the page, and it sanitizes the payload. Denying it protected
 * nothing: `document.execCommand('copy')` reaches the same clipboard from
 * the same pages, and no Electron API can close that path; the deny only
 * broke every modern copy button, on ordinary websites too.
 *
 * READING stays denied, and is the direction that matters: `clipboard-read`
 * and `deprecated-sync-clipboard-read` would hand a page whatever the
 * person last copied anywhere else, which is how a seed phrase or a
 * password leaves the machine.
 */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-sanitized-write',
  // Only from a click in the page, and Escape always leaves: the browser
  // process takes that key before the page sees it. `automatic-fullscreen`,
  // the name that waives the click, stays denied. ./README.md has the rest.
  'fullscreen',
  // Chromium refuses pointer lock without a click, and Escape releases it in
  // the browser process. Keyboard lock takes effect only in fullscreen, where
  // holding Escape still leaves. The shell draws both notices.
  'pointerLock',
  'keyboardLock'
])

/** Granted names whose one abuse the shell answers with a notice. */
const EXCLUSIVE_ACCESS: ReadonlySet<string> = new Set<ExclusiveAccess>(['fullscreen', 'pointerLock', 'keyboardLock'])

/**
 * `fileSystem` passes for ONE FILE, to read or to write, and never for a
 * directory. A page holds a handle to a file on disk only because the
 * person picked it in the OS dialog, or dropped or pasted it; the page
 * cannot name a path itself. A directory handle would reach every file
 * beneath it, and a child's handle needs the directory's grant first, so
 * refusing directories closes the whole tree. ADR-0024 argues this;
 * ./README.md's Design notes say why both handlers apply it.
 *
 * Details that do not state `isDirectory: false` deny: the gate trusts an
 * explicit "one file", never the absence of "directory".
 */
function isAllowed (permission: string, details: object | undefined): boolean {
  if (ALLOWED_PERMISSIONS.has(permission)) return true
  return permission === 'fileSystem' && details !== undefined && 'isDirectory' in details && details.isDirectory === false
}

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
 * shape: this file's own top-level doc says `contents` IS the captured tab
 * for a tab-capture request, so this is the tab at the moment access is
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
function allowTabCaptureMediaRequest (contents: WebContents, details: object | undefined): boolean {
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

let decisions: NotificationDecisions | undefined

/** Every session's one store of per-site notification answers, so a site
 * decided in one partition is decided in all. */
export function notificationDecisions (): NotificationDecisions {
  decisions ??= new NotificationDecisions(join(app.getPath('userData'), 'notification-decisions.json'))
  return decisions
}

const externalLinks = createExternalLinks({ windowShowing, confirm: confirmExternalLink })
const siteNotifications = createSiteNotifications({
  decisions: { get: (origin) => notificationDecisions().get(origin), set: (origin, decision) => { notificationDecisions().set(origin, decision) } },
  windowShowing,
  ask: askNotificationPermission
})

/** Answers a request that waits on the person. */
function answerWhenAsked (answer: Promise<boolean>, callback: (granted: boolean) => void): void {
  answer.then(callback, () => { callback(false) })
}

/** Before the answer, so the shell is watching when the page enters
 * fullscreen; a notice that fails must never cost the page its answer. */
function noteForNotice (contents: WebContents, permission: string): void {
  if (!EXCLUSIVE_ACCESS.has(permission)) return
  try {
    noteExclusiveAccess(contents, permission as ExclusiveAccess)
  } catch (error) {
    console.error(`[permission-gate] no notice for ${permission}:`, error)
  }
}

/** Idempotent: installing the same three handlers on a session twice (the
 * defensive `afterReady` call below, on top of whatever `session-created`
 * already covered) just overwrites each with an identical function. */
function denyByDefault (target: Session): void {
  target.setPermissionRequestHandler((contents, permission, callback, details) => {
    // A page an app shows in a <webview> reaches another program only if the
    // app decides to, through its own grants (ADR-0047): never through a prompt here.
    if (permission === 'openExternal') return contents.getType() === 'webview' ? callback(false) : answerWhenAsked(externalLinks(contents, details), callback)
    if (permission === 'notifications') return answerWhenAsked(siteNotifications.request(contents, details), callback)
    if (permission === 'media') return callback(allowTabCaptureMediaRequest(contents, details))
    const allowed = isAllowed(permission, details)
    if (allowed) noteForNotice(contents, permission)
    callback(allowed)
  })
  // Synchronous, so it can never ask: an external link is always refused
  // here, and notifications answer from what the person already said.
  target.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    if (permission === 'notifications') return siteNotifications.check(requestingOrigin, details.embeddingOrigin)
    // Always false for 'media', never a shape check --
    // allowTabCaptureMediaRequest's own doc says why: this handler fires
    // speculatively, with no getUserMedia() call behind it (marking
    // consumption here released a still-unredeemed grant early, measured),
    // AND it has no captured-tab identity to check against even when a real
    // call is behind it -- `wc`/`requestingOrigin` here are the REQUESTER's
    // own, never the target tab, so the tab-identity check
    // cannot be applied in this handler at all. Refusing 'media' here
    // outright costs nothing real: Electron only consults this handler to
    // decide whether to ask via setPermissionRequestHandler in the first
    // place for some call shapes, and the request handler above is the one
    // that actually grants a tab-capture 'media' call.
    if (permission === 'media') return false
    return isAllowed(permission, details)
  })
  // WebHID/WebUSB/Web Serial have no capability path at all in v0
  // (security-model.md: "subprocess and hid are absent from the v0 API
  // entirely") -- deny outright rather than falling through to whatever a
  // device chooser dialog would otherwise return.
  target.setDevicePermissionHandler(() => false)
  // setDisplayMediaRequestHandler deliberately left UNSET: this fix denies
  // getDisplayMedia, and Electron's own default with no handler installed
  // is exactly that. Installing one is only needed to build a real
  // screen-share picker, which is a feature, not this fix.
}

export const permissionGateSubsystem: Subsystem = {
  name: 'permission-gate',
  // A boundary the product's own headline claim depends on
  // (security-model.md: "apps only reach what they were granted")
  // enforcing nothing is exactly the failure registry.ts's `critical` flag
  // exists for -- see criticalFailureMessage's own doc comment.
  critical: true,
  beforeReady: () => {
    app.on('session-created', denyByDefault)
  },
  // Belt-and-suspenders for a timing question this fix cannot fully close
  // from JS: Electron's own docs do not state exactly when the default
  // session is first created relative to a subsystem's beforeReady, only
  // that `session.defaultSession` itself is not safe to read until
  // app.whenReady() resolves. If 'session-created' already caught it, this
  // is a harmless no-op re-application.
  afterReady: () => {
    denyByDefault(session.defaultSession)
  }
}
