// An AppImage that the one-line installer unpacked (docs/development/packaging.md section Linux one-line install) is a
// packaged program run from a folder, so `APPIMAGE` is not set and `process.execPath` is a real file that stays. What it
// keeps is the `AppRun` beside the executable, which decides at each start whether the sandbox can be used. Plain Node.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The AppRun beside `execPath`, or undefined when there is none: a .deb, a run from source, Windows and macOS have no such file. */
export function unpackedAppRun (execPath: string, exists: (path: string) => boolean = existsSync): string | undefined {
  const appRun = join(dirname(execPath), 'AppRun')
  return exists(appRun) ? appRun : undefined
}
