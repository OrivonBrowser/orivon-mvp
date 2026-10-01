// Real inputs for `fs.userSelected`'s picker guard, beyond THIS session's own
// `app.getPath('userData')` (`../adapters/node-fs-adapter.ts`'s `nodeFs`
// exposes that as `BrokerFs.dataRoot()`). Both exports here answer BY RULE,
// never by a snapshot of what currently exists, because a profile or private
// session created after the broker starts must be protected exactly like one
// already running -- `../capabilities/user-selected.ts`'s `createPickGuardCheck`
// calls both fresh on every pick, not once at broker creation. Split out of
// `./ipc.ts` (code-guidelines.md Rule 2) once wiring this pushed that file
// past its line budget.

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { App } from 'electron'
import { isPrivateDirName } from '../../main/launch/private-session.js'

/**
 * `app.getPath('userData')` already reflects WHICHEVER profile or private
 * session THIS process is running -- `main/launch/start-launch.ts` swaps
 * it once, at startup, before anything else reads it -- so the DEFAULT
 * profile's own directory, where `ProfileStore` keeps every other
 * profile's `profiles/<id>` subdirectory, has to be reconstructed the same
 * way Electron computes `userData` by default, rather than read back off
 * `app` (which is this process's own, possibly-overridden answer).
 */
function defaultProfileHome (app: Pick<App, 'getPath' | 'getName'>): string {
  return join(app.getPath('appData'), app.getName())
}

/**
 * The default profile's own directory -- every OTHER profile lives inside it
 * (`profiles/<id>`), so `../policy/picker-blocklist.ts`'s own ancestor-or-
 * equal rule already refuses a pick under any of them, including one made
 * after this call, without this needing to name it separately.
 */
export function additionalProtectedRoots (app: Pick<App, 'getPath' | 'getName'>): readonly string[] {
  return [defaultProfileHome(app)]
}

/**
 * `../policy/picker-blocklist.ts`'s `PickerGuardRoots.privateSessions`:
 * every private session sits directly under `os.tmpdir()`, named the way
 * `../../main/launch/private-session.ts`'s own `mkdtempSync` call names it.
 * Matched by that shape, not by which such directories happen to exist when
 * this is called, so a session started later is covered exactly like one
 * already running.
 */
export function privateSessionGuard (): { readonly tempDir: string, readonly isPrivateDirName: (name: string) => boolean } {
  return { tempDir: tmpdir(), isPrivateDirName }
}

/** A message for the person, drawn by whatever the shell publishes (`ctx.showNotice`). */
export interface Notice { readonly title: string, readonly message: string }

/**
 * §Contracts' "the picker says why" -- shown to the PERSON, never to the
 * app: by the time this runs, `fs.userSelected` has already resolved the
 * app's own call as a plain cancellation (`null` or `[]`), indistinguishable
 * from one the person chose themselves. Nothing downstream of a refused pick
 * waits on the notice being dismissed. The notice is drawn by `show`, which
 * the shell supplies: this layer may not import the shell's panel code, and
 * a refusal with nothing to show it on only reaches the log.
 */
export function notifyPickRefused (info: { readonly origin: string, readonly appName: string | undefined, readonly reason: string }, show: ((notice: Notice) => void) | undefined): void {
  const requester = info.appName === undefined ? info.origin : `"${info.appName}" (${info.origin})`
  const notice = {
    title: 'Folder or file not allowed',
    message: `${requester} asked to use a folder or file Orivon will not hand over: ${info.reason}.`
  }
  if (show === undefined) console.error(`[picker] ${notice.message}`)
  else show(notice)
}
