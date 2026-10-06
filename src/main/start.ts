import { app } from 'electron'
import { createRequire } from 'node:module'
import { startLaunch } from './launch/start-launch.js'

// The process entry. It reads nothing but the launch code, so a second start of a profile that is already open asks
// for the single-instance lock and exits before the rest of the browser (index.ts, most of this build) is loaded:
// loading it is about half of what such a start costs. Imports here stay within electron, node:module and
// launch/start-launch.js (tests/start.test.ts holds that).

// An uncaught main-process error is logged and the process exits. Electron's default is a modal error dialog, which
// keeps its process alive until someone clicks it: on an unattended run, a window left on the screen and a process
// tree that never exits. Registered above every other statement, because a throw before this line still gets the
// dialog. Nothing is hidden: the error is printed in full, and the non-zero exit is what a test runner reads.
function exitOnUncaught (kind: string, error: unknown): void {
  console.error(`[orivon] ${kind} in the main process:`, error)
  app.exit(1)
}

process.on('uncaughtException', (error) => { exitOnUncaught('uncaught exception', error) })
process.on('unhandledRejection', (reason) => { exitOnUncaught('unhandled promise rejection', reason) })

// Which browser this process is, before anything reads a byte of data: another profile or a private session
// has a directory of its own, and a second start of a profile already open hands over and stops here.
const runtime = startLaunch(app, process.argv)
if (runtime !== null) {
  // A require at this point, not an import at the top: the bundle's static imports would all be evaluated first.
  const browser = createRequire(import.meta.url)('./index.js') as typeof import('./index.js')
  browser.boot(runtime)
}
