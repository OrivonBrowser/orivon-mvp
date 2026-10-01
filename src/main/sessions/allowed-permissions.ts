// The names a page may use without asking anyone, and the predicate that
// applies them. Pure: nothing here imports `electron`, so the permission
// gate's test can drive it under plain vitest.
import type { ExclusiveAccess } from '../shell/exclusive-access-notice.js'

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
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
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
export const EXCLUSIVE_ACCESS: ReadonlySet<string> = new Set<ExclusiveAccess>(['fullscreen', 'pointerLock', 'keyboardLock'])

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
export function isAllowed (permission: string, details: object | undefined): boolean {
  if (ALLOWED_PERMISSIONS.has(permission)) return true
  return permission === 'fileSystem' && details !== undefined && 'isDirectory' in details && details.isDirectory === false
}

