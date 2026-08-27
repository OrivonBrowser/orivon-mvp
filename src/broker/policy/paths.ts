// Decides whether a path an app asked for is safely inside that app's own
// directory. T1 and T10 in docs/architecture/security-model.md, and the
// flagship's happy path rather than an edge case: a .torrent file declares
// its own file names, and `../../../.ssh/authorized_keys` is an entire CVE
// class in BitTorrent clients.
//
// handle-contracts.md SSFileHandle: paths are resolved and confined IN THE
// BROKER, never trusted from the renderer, and an escape is `denied`.
//
// TWO CHECKS, BOTH NECESSARY. This is the whole content of the file:
//
//   1. `path.relative`, NOT `startsWith`. A string-prefix test accepts
//      `/apps/foo-evil` against root `/apps/foo` -- same prefix, different
//      app, full read and write of someone else's files. `relative` answers
//      the question actually being asked ("how do I get there from here?")
//      and returns `../foo-evil`, which is visibly an escape.
//   2. `realpath` on the deepest EXISTING ancestor. `path.resolve` collapses
//      `..` textually and DOES NOT FOLLOW SYMLINKS, so `root/link/passwd`
//      where `link -> /etc` sails through check 1 and opens /etc/passwd.
//
// Neither check subsumes the other, and each on its own is a full compromise.
//
// WHY `realpath` IS A PARAMETER. It is the only I/O this decision needs, and
// src/broker/policy/README.md forbids I/O in this directory: the broker is
// built as createBroker({ ..., fs, ... }) so that every security test runs
// against stubs with no Electron and no filesystem. It also makes the symlink
// rows in the table testable without planting real symlinks in a temp dir --
// which is what makes them get written at all.
//
// WHY THE VERDICT IS PLATFORM-INDEPENDENT. Windows and macOS are supported
// run-from-source targets (build-plan.md), but CI runs on Linux only. A
// confinement rule whose answer depends on the host OS is therefore a rule
// that ships to two platforms untested. So:
//
//   - Path flavour is chosen from the SHAPE OF THE ROOT (`C:\...` or `\\...`
//     -> win32, otherwise posix), not from `process.platform`. A Windows root
//     gets Windows separator rules on a Linux test runner.
//   - Everything Windows-specific about the REQUESTED path -- backslashes,
//     drive letters, UNC prefixes, reserved device names -- is rejected on
//     every platform. `..\..\Windows` is a legal single filename on POSIX, but
//     accepting it here would mean the same input has two different meanings
//     depending on where the broker happens to be running, and a security
//     boundary must not have platform-dependent semantics.
//
// WHAT THIS FUNCTION DOES NOT DO -- read before using the result:
//
//   - It confines the deepest existing ancestor, so a symlink planted at the
//     LEAF between this check and the open still escapes. The caller must
//     open with O_NOFOLLOW (or lstat the leaf) for the final component. Pure
//     path arithmetic cannot close a TOCTOU window; only the open can.
//   - It does not check the grant, the quota, or the capability. It answers
//     one question: is this path inside that root.

import { posix, win32 } from 'node:path'
import type { PlatformPath } from 'node:path'
import type { OrivonErrorCode } from '../../contracts/errors.js'
import { WINDOWS_DEVICE_NAME_PATTERN } from './windows-device-names.js'

/**
 * Why every rejection is the SAME error code, whatever the reason.
 *
 * contracts/errors.ts on 'denied': "If denials varied by reason, an app could
 * iterate through them and map exactly which pattern, port or address class
 * is blocked, turning the permission boundary itself into a probe target."
 * A path oracle is the same hazard -- distinguishable rejections would let an
 * app map the filesystem outside its root one probe at a time.
 *
 * The `reason` below is for the broker's LOCAL LOG. It must never reach the
 * renderer.
 */
export const CONFINEMENT_ERROR_CODE: OrivonErrorCode = 'denied'

/**
 * Closed union rather than the free-form string the task sketched, so the
 * broker's logging switch is exhaustive and a new reason cannot be added
 * without every call site being told about it. Same reasoning as
 * OrivonErrorCode, one layer down.
 */
export type ConfineDenialReason =
  /** `root` was not absolute under its own flavour. A broker bug, not an app's. */
  | 'root-not-absolute'
  /** `realpath(root)` failed or returned something unusable. A broker bug. */
  | 'root-unresolvable'
  /** A NUL byte appeared in `root` or `requested`. */
  | 'nul-byte'
  /** `requested` was empty or only whitespace. */
  | 'empty'
  /** `requested` was absolute, POSIX or UNC. Always rejected, never re-rooted. */
  | 'absolute'
  /** `requested` contained a backslash. */
  | 'backslash'
  /** `requested` began with a drive letter (`C:\`, `C:/` or drive-relative `C:x`). */
  | 'windows-drive'
  /** A segment names a Windows device (CON, NUL, COM1, ...). */
  | 'reserved-name'
  /** `requested` resolved to the root directory itself. */
  | 'is-root'
  /** `requested` resolved outside the root by `..` or by being absolute. */
  | 'escapes-root'
  /** An existing ancestor is a symlink whose target lies outside the root. */
  | 'symlink-escape'
  /** `realpath` returned a path that is not absolute. Fail closed. */
  | 'unresolvable'

export type ConfineResult =
  | { readonly ok: true; readonly resolved: string }
  | { readonly ok: false; readonly reason: ConfineDenialReason }

const NUL = '\u0000'

/**
 * Windows device names. `C:\apps\foo\CON` is INSIDE the root by every path
 * calculation there is, and still opens the console device rather than a
 * file -- the confinement is correct and irrelevant. The same holds for any
 * extension (`CON.txt`) and for trailing dots or spaces (`CON.`, `CON `),
 * which Win32 strips before it looks the name up.
 *
 * The table itself is shared with canonical-path.ts (./windows-device-
 * names.ts); this file uppercases its input first, so the RegExp built from
 * it is case-sensitive rather than carrying an `/i` flag.
 */
const WINDOWS_DEVICE = new RegExp(WINDOWS_DEVICE_NAME_PATTERN)

/** A leading drive designator in any form: `C:\x`, `C:/x`, or drive-relative `C:x`. */
const WINDOWS_DRIVE_PREFIX = /^[a-zA-Z]:/

/** Two leading separators: a UNC share (`\\server\share`) or a `\\?\` extended path. */
const UNC_PREFIX = /^[\\/]{2}/

/**
 * The flavour is taken from the root's own shape, never from process.platform
 * -- see the header. In production the broker builds the root from the app
 * data directory, so this picks win32 on Windows and posix elsewhere, which
 * is the right answer; in tests it makes a Windows root behave like Windows
 * on a Linux runner, which is the only reason those rows can exist.
 */
function flavourFor (root: string): PlatformPath {
  return WINDOWS_DRIVE_PREFIX.test(root) || UNC_PREFIX.test(root) ? win32 : posix
}

/**
 * True if a relative path leaves the directory it is relative to.
 *
 * `rel === '..'` and the `'..' + sep` prefix are checked separately, and NOT
 * as `rel.startsWith('..')`, because a file legitimately named `..bar` yields
 * exactly `..bar` here. The naive form rejects it -- fail-closed, but wrong,
 * and the same sloppiness in the other direction is how prefix bugs happen.
 *
 * `isAbsolute` is not redundant. On Windows, `relative` between two different
 * drives cannot express an answer and returns the absolute target instead:
 * relative('C:\\apps\\foo', 'D:\\secrets') === 'D:\\secrets'. Nothing in that
 * string begins with `..`.
 */
function escapes (rel: string, flavour: PlatformPath): boolean {
  return rel === '..' || rel.startsWith(`..${flavour.sep}`) || flavour.isAbsolute(rel)
}

/** True if `segment` names a Windows device under any spelling. */
function isReservedName (segment: string): boolean {
  const base = (segment.split('.')[0] ?? segment).replace(/[ .]+$/, '').toUpperCase()
  return WINDOWS_DEVICE.test(base)
}

function deny (reason: ConfineDenialReason): ConfineResult {
  return { ok: false, reason }
}

/**
 * Resolve `requested` against `root` and confirm the result cannot leave it.
 *
 * @param root Absolute directory the app is confined to. Broker-supplied,
 *   trusted for shape but validated anyway -- a relative root would make
 *   every check below meaningless, silently.
 * @param requested Untrusted: renderer IPC, or a file name out of a .torrent.
 * @param realpath Canonicalises an existing path, following symlinks. May
 *   throw for a path that does not exist yet; that is expected and handled
 *   (a file being created, or a directory tree not yet made). In the broker
 *   this is `fs.realpathSync`.
 * @returns The absolute path to open, or a rejection reason for the log.
 *   Every rejection is reported to the app as CONFINEMENT_ERROR_CODE.
 */
export function confinePath (
  root: string,
  requested: string,
  realpath: (p: string) => string
): ConfineResult {
  const flavour = flavourFor(root)

  if (root.includes(NUL)) return deny('nul-byte')
  if (!flavour.isAbsolute(root)) return deny('root-not-absolute')

  // Safe against the purity rule: `resolve` consults process.cwd() only when
  // it runs out of absolute arguments, and root is absolute by the line
  // above. Every resolve and relative below inherits that guarantee.
  const normRoot = flavour.resolve(root)

  // A NUL truncates the path in the C library underneath every filesystem
  // call, so `secret.txt\0.jpg` passes an extension check as a .jpg and then
  // opens secret.txt. Node's fs rejects these, but this function's answer is
  // consumed as "this path is safe", so it must not depend on a later layer
  // happening to be careful.
  if (requested.includes(NUL)) return deny('nul-byte')

  // Whitespace-only is not a filename anyone meant. It also aliases: Win32
  // strips trailing spaces, so '   ' names the root directory itself.
  if (requested.trim() === '') return deny('empty')

  // The three rejections below are unconditional, on every platform, so that
  // one input has one verdict everywhere -- see the header.
  if (WINDOWS_DRIVE_PREFIX.test(requested)) return deny('windows-drive')
  if (requested.includes('\\')) return deny('backslash')

  // Both flavours, not just the selected one. `//server/share` is not
  // absolute to win32 alone, and `/etc/passwd` is caught by either; asking
  // both is one comparison and removes the last platform-dependent branch.
  if (posix.isAbsolute(requested) || win32.isAbsolute(requested)) return deny('absolute')

  // Check 1. Textual: collapses `..`, and settles the sibling-prefix case.
  const resolved = flavour.resolve(normRoot, requested)
  const rel = flavour.relative(normRoot, resolved)
  if (rel === '') return deny('is-root')
  if (escapes(rel, flavour)) return deny('escapes-root')

  // `relative` output is normalised and, having survived `escapes`, contains
  // no `..` and no `.` segments at all -- so these are literal names.
  const segments = rel.split(flavour.sep)
  if (segments.some(isReservedName)) return deny('reserved-name')

  // Canonicalise the root as well, not just the descendants. On macOS
  // /var is a symlink to /private/var, so a root under it realpaths to a
  // string the un-canonicalised root is not a prefix of -- comparing
  // canonical against raw would deny every path the app ever asks for, and
  // only on macOS. Canonical is only ever compared with canonical.
  let canonicalRoot: string
  try {
    canonicalRoot = realpath(normRoot)
  } catch {
    return deny('root-unresolvable')
  }
  if (!flavour.isAbsolute(canonicalRoot)) return deny('root-unresolvable')

  // Check 2. Walk down-to-up for the deepest ancestor that exists.
  //
  // The full path is tried FIRST, which is strictly stronger than starting at
  // the parent: when the leaf already exists and is itself a symlink, this is
  // what catches it. When it does not exist, there is nothing at the leaf to
  // follow yet -- see the TOCTOU note in the header for what remains.
  //
  // Walking up is required, not an optimisation: a torrent writing
  // `Show/Season 1/ep.mkv` has none of those directories yet, and a check
  // that gave up at the first missing component would reject the flagship's
  // own happy path. Indexing rather than repeated dirname() bounds the loop
  // at the segment count, so no attacker-supplied string can make it spin.
  let canonical = canonicalRoot
  for (let depth = segments.length; depth >= 1; depth--) {
    try {
      canonical = realpath(flavour.join(normRoot, ...segments.slice(0, depth)))
      break
    } catch {
      // Does not exist yet. Try its parent.
    }
  }

  // A realpath that hands back a relative string is a broken injection, and
  // resolving it would silently consult the cwd this function promised never
  // to read. Fail closed instead.
  if (!flavour.isAbsolute(canonical)) return deny('unresolvable')

  // Empty is allowed here, unlike check 1: the deepest existing ancestor may
  // legitimately be the root itself. Comparison is case-SENSITIVE and stays
  // that way. Case-folding to accommodate macOS and Windows would accept
  // /apps/FOO/x as inside /apps/foo, and on a case-sensitive volume that is
  // a different directory -- i.e. an escape. Cross-platform roots are
  // sha256(origin) hex (T13b), single-case, so nothing legitimate collides.
  const canonicalRel = flavour.relative(canonicalRoot, canonical)
  if (canonicalRel !== '' && escapes(canonicalRel, flavour)) return deny('symlink-escape')

  // `resolved` rather than `canonical`: the caller gave us a root and gets
  // back a path in those same terms, which is what its quota accounting and
  // logs are keyed on. Opening it traverses exactly the symlinks just proven
  // to stay inside, so the two reach the same file.
  return { ok: true, resolved }
}
