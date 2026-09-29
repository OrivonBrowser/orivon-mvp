// Real inputs for `fs.userSelected`'s picker guard: every OTHER
// profile directory and every private-session directory this machine
// currently has, beyond THIS session's own `app.getPath('userData')`
// (which `../adapters/node-fs-adapter.ts`'s `nodeFs` already exposes as
// `BrokerFs.dataRoot()` -- `../capabilities/user-selected.ts`'s own guard
// treats every root from both sources identically: a pick that overlaps
// ANY of them, in either direction, is refused). Split out of `./ipc.ts`
// (code-guidelines.md Rule 2) once wiring this pushed that file past its
// line budget.

import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import type { App } from 'electron'
import { ProfileStore } from '../../main/launch/profile-store.js'
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
 * Every profile directory (the default one and each under `profiles/`) and
 * every private-session directory this machine currently has, whether or
 * not it belongs to a still-running process -- a stale one, not yet swept,
 * still names a directory that once held real browsing data, so it stays
 * on the list until the sweep itself removes it.
 */
export function additionalProtectedRoots (app: Pick<App, 'getPath' | 'getName'>): readonly string[] {
  const home = defaultProfileHome(app)
  const roots = new Set<string>([home])
  try {
    const store = new ProfileStore(home)
    for (const profile of store.list()) {
      const dir = store.dirOf(profile.id)
      if (dir !== null) roots.add(dir)
    }
  } catch {
    // No `profiles/` directory yet -- only the default profile exists.
  }
  try {
    const tmp = tmpdir()
    for (const name of readdirSync(tmp)) {
      if (isPrivateDirName(name)) roots.add(join(tmp, name))
    }
  } catch {
    // Nothing under the temp directory worth adding.
  }
  return [...roots]
}

/**
 * §Contracts' "the picker says why" -- shown to the PERSON, never to the
 * app: by the time this runs, `fs.userSelected` has already resolved the
 * app's own call as a plain cancellation (`null` or `[]`), indistinguishable
 * from one the person chose themselves. `void`, not awaited -- nothing
 * downstream of a refused pick is waiting on this box being dismissed.
 * Parented the same best-effort way the picker dialog itself is
 * (`./ipc.ts`'s own `pickPath` doc explains why the true sender's window
 * is not available at this seam yet).
 */
export function notifyPickRefused (info: { readonly origin: string, readonly appName: string | undefined, readonly reason: string }): void {
  const requester = info.appName === undefined ? info.origin : `"${info.appName}" (${info.origin})`
  const options = {
    type: 'warning' as const,
    title: 'Folder or file not allowed',
    message: `${requester} asked to use a folder or file Orivon will not hand over: ${info.reason}.`
  }
  const parent = BrowserWindow.getFocusedWindow()
  void (parent === null ? dialog.showMessageBox(options) : dialog.showMessageBox(parent, options))
}
