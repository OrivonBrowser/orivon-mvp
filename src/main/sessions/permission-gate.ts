// Deny-by-default gate for every Chromium permission a web page can ask
// for -- camera/microphone, clipboard reads, notifications, MIDI,
// idle-detection, pointer lock, and launching an external protocol
// handler, among others. `isAllowed` below says what passes, and why that
// is not a hole.
// Electron's own documented default, when no handler is installed on a
// session, is to APPROVE. See ./README.md's Design notes for why
// this is wired via `app.on('session-created', ...)` rather than at any
// one session's own construction site -- that placement is load-bearing,
// not a style choice, and moving it back "for clarity" reopens the gap.
import { app, session, type Session } from 'electron'
import type { Subsystem } from '../registry.js'

/**
 * Permissions this browser allows outright; `isAllowed` below adds the one
 * conditional name, and every other name Chromium can ask a session for is
 * denied. The grant ledger this product is built around
 * governs `orivon.*` capabilities, not Chromium's own, so a name belongs
 * here only when the web platform's own gating is what makes it safe --
 * never because an app asked for it. ADR-0022 argues the entry below.
 *
 * `clipboard-sanitized-write` lets a page call
 * `navigator.clipboard.writeText()`. Chromium still requires transient
 * user activation and a focused document, so the person has to have just
 * acted in the page, and it sanitizes the payload. Denying it protected
 * nothing: `document.execCommand('copy')` reaches the same clipboard from
 * the same pages, and no Electron API can close that path. What the deny
 * did do was break every page that writes a copy button the modern way --
 * ordinary websites included, since this gate covers the default session
 * as well as app partitions.
 *
 * READING stays denied, and is the direction that matters: `clipboard-read`
 * and `deprecated-sync-clipboard-read` would hand a page whatever the
 * person last copied anywhere else, which is how a seed phrase or a
 * password leaves the machine.
 */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write'])

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

/** Idempotent: installing the same three handlers on a session twice (the
 * defensive `afterReady` call below, on top of whatever `session-created`
 * already covered) just overwrites each with an identical function. */
function denyByDefault (target: Session): void {
  target.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(isAllowed(permission, details))
  })
  target.setPermissionCheckHandler((_webContents, permission, _origin, details) => isAllowed(permission, details))
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
