// `fs.userSelected`'s real OS picker: the wording it shows and the
// `dialog.showOpenDialog` call itself. Split out of `./ipc.ts`
// (code-guidelines.md Rule 2) once wiring this pushed that file past its
// line budget.

import { BaseWindow, dialog } from 'electron'
import type { PickPath } from '../broker-contracts.js'

/**
 * The text `pickPath`'s real `dialog.showOpenDialog` call shows. Kept as a
 * pure function, separate from the `electron` call itself, so it is
 * testable without Electron -- `dialog` is a real Electron value import
 * and cannot be exercised from a plain-Node suite.
 *
 * The folder wording is owner-approved verbatim (`d-0032`), and `origin`
 * (never just `appName`) is what names the requester -- see README.md's
 * Design notes for why both are worded the way they are.
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
 * own picker, worded by `describePickerDialog` above. Parented to the
 * window the person is using (the focused one, else the newest visible one), not the real
 * sender's own -- see README.md's Design notes for why that is what "parented"
 * means here. `BaseWindow`, because every shell window is one and
 * `BrowserWindow.getFocusedWindow()` never returns one.
 */
export function createPickPath (): PickPath {
  return async ({ directory, multiple, appName, origin }) => {
    const properties: Array<'openFile' | 'openDirectory' | 'multiSelections'> = directory
      ? ['openDirectory']
      : (multiple ? ['openFile', 'multiSelections'] : ['openFile'])
    const { title, buttonLabel, message } = describePickerDialog({ directory, multiple, appName, origin })
    const parent = BaseWindow.getFocusedWindow() ?? BaseWindow.getAllWindows().filter((window) => !window.isDestroyed() && window.isVisible()).at(-1) ?? null
    const result = parent === null
      ? await dialog.showOpenDialog({ properties, title, buttonLabel, message })
      : await dialog.showOpenDialog(parent, { properties, title, buttonLabel, message })
    return result.canceled ? { canceled: true } : { canceled: false, paths: result.filePaths }
  }
}
