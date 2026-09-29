// `fs.userSelected`'s real OS picker: the wording it shows and the
// `dialog.showOpenDialog` call itself. Split out of `./ipc.ts`
// (code-guidelines.md Rule 2) once wiring this pushed that file past its
// line budget.

import { BrowserWindow, dialog } from 'electron'
import type { PickPath } from '../broker-contracts.js'

/**
 * The text `pickPath`'s real `dialog.showOpenDialog` call shows. Kept as a
 * pure function, separate from the `electron` call itself, so it is
 * testable without Electron -- `dialog` is a real Electron value import
 * and cannot be exercised from a plain-Node suite.
 *
 * FOLDER WORDING IS OWNER-APPROVED VERBATIM (`d-0032`, 2026-09-16): three
 * drafts were proposed, and the owner chose the strongest, on the reasoning
 * that "read and write" understated what a folder grant really lets an app
 * do. `message`'s "including files you add to it later" is the load-bearing
 * phrase -- the thing people misread about a folder pick -- and is not
 * trimmed for length. FILE/multi-file wording follows the same voice but is
 * DERIVED, not separately owner-reviewed word for word: `permissions.ts`'s
 * `describePickedPath` carries the identical reasoning for why it says
 * "change" rather than claim a delete a `FileHandle` cannot perform.
 *
 * `message` is macOS-only (Electron's own `OpenDialogOptions` doc); passed
 * unconditionally because Electron silently ignores it elsewhere rather
 * than erroring, confirmed against Electron's own docs (context7,
 * 2026-09-16) before writing this. The delete warning must be seen on
 * every platform, so it ALSO goes in `title` -- the one field Electron
 * renders on every platform's own folder/file dialog; `message` still
 * carries the fuller macOS text unchanged.
 *
 * `origin`, NEVER JUST `appName`, is what names the requester: the
 * ORIGINAL wording named no origin at all, and a registered app's
 * self-declared `appName` is the app's own claim about itself -- an
 * attacker origin can declare whatever friendly name it likes. `origin`
 * is derived from the sender's frame (T3) and cannot be spoofed the way a
 * manifest's `name` can, so it is what actually appears; `appName`, when
 * present, is added alongside it for a person who recognises the app by
 * name, never in its place.
 */
export function describePickerDialog (opts: { directory: boolean, multiple: boolean, appName: string | undefined, origin: string }): { title: string, buttonLabel: string, message: string } {
  const requester = opts.appName === undefined ? opts.origin : `"${opts.appName}" (${opts.origin})`
  if (opts.directory) {
    const warning = 'it can read, change and delete everything in this folder, including files you add to it later'
    return {
      title: `Choose a folder for ${requester} -- ${warning}`,
      buttonLabel: 'Allow access to this folder',
      message: `This app will be able to read, change and delete everything in this folder, including files you add to it later. Requested by ${requester}.`
    }
  }
  if (opts.multiple) {
    const warning = 'it can read and change these files, including emptying them'
    return {
      title: `Choose files for ${requester} -- ${warning}`,
      buttonLabel: 'Allow access to these files',
      message: `This app will be able to read and change these files, including emptying them. Requested by ${requester}.`
    }
  }
  const warning = 'it can read and change this file, including emptying it'
  return {
    title: `Choose a file for ${requester} -- ${warning}`,
    buttonLabel: 'Allow access to this file',
    message: `This app will be able to read and change this file, including emptying it. Requested by ${requester}.`
  }
}

/**
 * The real `PickPath` `../index.ts`'s `CreateBrokerOptions` wants: Electron's
 * own picker, worded by `describePickerDialog` above.
 *
 * PARENTED TO THE FOCUSED WINDOW: the real sender's own `BrowserWindow` is
 * not on this function's signature (`ControlEvent` carries only
 * `senderFrame`, structural-typed for testability -- `./ipc.ts`'s own
 * header). A page can only reach this call at all with a fresh user
 * activation (checked in the isolated-world preload before the IPC is even
 * sent), so the focused window is, in practice, the sender's own -- a real
 * cross-window dialog-parenting fix belongs with `ControlEvent` gaining the
 * sender's `WebContents`, which the session lane's own attribution work may
 * already add; noted rather than duplicated here to avoid two competing
 * changes to this same handler.
 */
export function createPickPath (): PickPath {
  return async ({ directory, multiple, appName, origin }) => {
    const properties: Array<'openFile' | 'openDirectory' | 'multiSelections'> = directory
      ? ['openDirectory']
      : (multiple ? ['openFile', 'multiSelections'] : ['openFile'])
    const { title, buttonLabel, message } = describePickerDialog({ directory, multiple, appName, origin })
    const parent = BrowserWindow.getFocusedWindow()
    const result = parent === null
      ? await dialog.showOpenDialog({ properties, title, buttonLabel, message })
      : await dialog.showOpenDialog(parent, { properties, title, buttonLabel, message })
    return result.canceled ? { canceled: true } : { canceled: false, paths: result.filePaths }
  }
}
