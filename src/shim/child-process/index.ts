// `child_process` module target (module-map.ts). A child is WebAssembly or
// JavaScript in a Worker, never an operating-system process (ADR-0040):
// `spawn` runs a WASI program from the app's bundle and `fork` an app
// module. The synchronous forms refuse by name.

import { refuseShim } from '../errors.js'
import { nodeModule } from '../polyfills/module-proxy.js'
import { ChildProcess } from './child.js'
import { exec, execFile } from './exec.js'
import { fork } from './fork.js'
import { spawn } from './spawn.js'

/** A synchronous form would block the page until the child ends, and the page's thread may not wait. */
function syncForm (name: string, instead: string): () => never {
  return function () {
    throw refuseShim(`child_process.${name}`, 'not-applicable',
      `${name} would block the page's thread until the child ends; use ${instead} and its callback or promise`)
  }
}

export const spawnSync = syncForm('spawnSync', 'spawn')
export const execSync = syncForm('execSync', 'exec')
export const execFileSync = syncForm('execFileSync', 'execFile')

export { ChildProcess, exec, execFile, fork, spawn }

export default nodeModule('child_process', { ChildProcess, spawn, fork, exec, execFile, spawnSync, execSync, execFileSync })
