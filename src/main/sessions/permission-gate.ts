// Deny-by-default gate for every Chromium permission a web page can ask
// for -- camera/microphone, clipboard reads, geolocation, MIDI, among
// others. `site-asks.ts` answers first for the names a site is asked about,
// then `allowed-permissions.ts` says which names pass outright, and
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
import { windowShowing } from '../shell/showing-window.js'
import { EXCLUSIVE_ACCESS, isAllowed } from './allowed-permissions.js'
import { createExternalLinks } from './external-links.js'
import { askSite } from '../site-settings/ask-site.js'
import { NotificationDecisions } from './notification-decisions.js'
import { siteAsks } from './site-asks.js'
import { createSiteNotifications } from './site-notifications.js'
import { allowTabCaptureMediaRequest } from './tab-capture-media.js'

let decisions: NotificationDecisions | undefined
let privateRuntime = false
let isAppOrigin: (origin: string) => boolean = () => false

/** Every session's one store of per-site notification answers, so a site
 * decided in one partition is decided in all. */
export function notificationDecisions (): NotificationDecisions {
  decisions ??= new NotificationDecisions(privateRuntime ? null : join(app.getPath('userData'), 'notification-decisions.json'))
  return decisions
}

const externalLinks = createExternalLinks({ windowShowing, confirm: async (_window, question, tab) => await confirmExternalLink({ contents: tab }, question) })
let notificationsBlocked: () => boolean = () => false

/**
 * What the per-site installer knows about this process, before the first answer is read: a private runtime keeps its
 * notification answers in memory like every other per-site answer, and a registered app's origin is never asked.
 */
export function configureSiteNotifications (options: { isPrivate: boolean, isApp: (origin: string) => boolean }): void {
  privateRuntime = options.isPrivate
  isAppOrigin = options.isApp
}

/** Whether `sites.notifications` is `block`; the per-site installer supplies it once the settings are loaded. */
export function setNotificationsBlockedCheck (check: () => boolean): void {
  notificationsBlocked = check
}

const siteNotifications = createSiteNotifications<object, WebContents>({
  decisions: { get: (origin) => notificationDecisions().get(origin), set: (origin, decision) => { notificationDecisions().set(origin, decision) } },
  windowShowing,
  // The same prompt under the address bar every per-site question uses, so the answer is the person's and the page cannot time it.
  ask: async (_window, _origin, tab) => await askSite(['notifications'], tab),
  blockedByDefault: () => notificationsBlocked(),
  isApp: (origin) => isAppOrigin(origin)
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
    // A per-site asker answers first, for the names it owns and only in a tab.
    const sited = siteAsks.request(contents, permission, details)
    if (sited !== undefined) return answerWhenAsked(sited, callback)
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
  target.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const sited = siteAsks.check(contents, permission, requestingOrigin, details)
    if (sited !== undefined) return sited
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
