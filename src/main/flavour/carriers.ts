// Where a first run may have been tagged, read from the process and the disk: the switch, the AppImage's own file name and
// the file the Windows installer writes beside the executable. What each says is `flavours.ts`'s to decide.
import { closeSync, openSync, readSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { flavourSwitch } from '../launch/launch-context.js'
import type { Carriers } from './flavours.js'

/** Written by the Windows installer (`build/installer.nsh`) with the name of the file it was started from. */
export const INSTALLER_NAME_FILE = 'installer-name.txt'
const MAX_NAME_BYTES = 512

/** The first line of `installer-name.txt` beside `execPath`, or null when it is missing or unreadable. */
export function readInstallerName (execPath: string): string | null {
  let fd: number | undefined
  try {
    fd = openSync(join(dirname(execPath), INSTALLER_NAME_FILE), 'r')
    const buffer = Buffer.alloc(MAX_NAME_BYTES)
    const length = readSync(fd, buffer, 0, MAX_NAME_BYTES, 0)
    const line = buffer.toString('utf8', 0, length).split(/\r?\n/)[0]?.trim() ?? ''
    return line === '' ? null : line
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function carriersOf (argv: readonly string[], env: NodeJS.ProcessEnv, execPath: string): Carriers {
  const appImage = env['APPIMAGE']
  return {
    switchValue: flavourSwitch(argv),
    appImageName: appImage === undefined || appImage === '' ? null : basename(appImage),
    installerName: readInstallerName(execPath)
  }
}
