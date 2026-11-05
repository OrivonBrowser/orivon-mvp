// Starting Orivon again: the one place that says with which command line. The profile and data directory the process
// started with are kept, and so is the app path of a run from source; the addresses and files it was started with are
// not (`withoutAddresses`), so a page launched from another program is not opened a second time. A caller that wants
// one page back names it.
import type { App } from 'electron'
import { urlsFromArgv, withoutAddresses } from './launch-context.js'

/** The command line, after the program, a new process starts with. `address` is opened as a plain tab when it is a web address; anything else is left out. */
export function relaunchArgs (argv: readonly string[], packaged: boolean, address?: string): string[] {
  const args = withoutAddresses(argv.slice(1), packaged)
  const [page] = address === undefined ? [] : urlsFromArgv([address], 1)
  return page === undefined ? args : [...args, page]
}

/** `argv` is the command line this process started with. Ends this process by `quit`, never `exit`: the stores flush before the browser closes. */
export function restartOrivon (app: Pick<App, 'relaunch' | 'quit' | 'isPackaged'>, argv: readonly string[], address?: string): void {
  app.relaunch({ args: relaunchArgs(argv, app.isPackaged, address) })
  app.quit()
}
