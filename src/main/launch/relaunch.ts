// Starting Orivon again: the one place that says with which command line. The profile and data directory the process
// started with are kept, and so is the app path of a run from source; the addresses and files it was started with are
// not (`withoutAddresses`), so a page launched from another program is not opened a second time. A caller that wants
// one page back names it.
import type { App } from 'electron'
import { urlsFromArgv, withoutAddresses } from './launch-context.js'

/** The command line, after the program, a new process starts with. `address` is opened as a plain tab when it is a web address, by its origin and path alone; anything else is left out. */
export function relaunchArgs (argv: readonly string[], packaged: boolean, address?: string): string[] {
  const args = withoutAddresses(argv.slice(1), packaged)
  const [page] = address === undefined ? [] : urlsFromArgv([address], 1)
  return page === undefined ? args : [...args, withoutDetails(page)]
}

/** Every user of the computer can read a process's command line (`/proc/<pid>/cmdline`), and a query, a fragment or a sign-in in an address can hold a token or a name. */
function withoutDetails (page: string): string {
  const url = new URL(page)
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return url.toString()
}

/**
 * `argv` is the command line this process started with. Ends this process by `quit`, never `exit`: the stores flush before the
 * browser closes. Inside an AppImage the program to start is the AppImage file (`peer-spawn.ts` learns it the same way): this
 * process's own executable sits in a mount that goes away with it, and a start from there would never happen.
 */
export function restartOrivon (app: Pick<App, 'relaunch' | 'quit' | 'isPackaged'>, argv: readonly string[], address?: string, env: NodeJS.ProcessEnv = process.env): void {
  const appImage = env['APPIMAGE']
  const args = relaunchArgs(argv, app.isPackaged, address)
  app.relaunch(app.isPackaged && appImage !== undefined && appImage !== '' ? { args, execPath: appImage } : { args })
  app.quit()
}
