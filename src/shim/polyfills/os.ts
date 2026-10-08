// `os` module target (module-map.ts): os-browserify's answers, with platform(),
// type() and arch() agreeing with `process` (node-identity.ts), homedir()
// and tmpdir() moved to the virtual root every other Node-shaped path agrees
// on (virtual-root.ts), and cpus() sized from the browser's own core count
// rather than os-browserify's empty array, since `os.cpus().length` is how
// Node code sizes a worker pool.

import browserOs from 'os-browserify/browser.js'
import { nodeModule } from './module-proxy.js'
import { NODE_IDENTITY } from '../node-identity.js'
import { VIRTUAL_ROOT, VIRTUAL_TMPDIR } from '../virtual-root.js'

export const EOL = browserOs.EOL
export function arch (): 'x64' { return NODE_IDENTITY.arch }
export const endianness = browserOs.endianness
export const freemem = browserOs.freemem
export const hostname = browserOs.hostname
export const loadavg = browserOs.loadavg
export const networkInterfaces = browserOs.networkInterfaces
export function platform (): 'linux' { return NODE_IDENTITY.platform }
export const release = browserOs.release
export const totalmem = browserOs.totalmem
export function type (): 'Linux' { return 'Linux' }
export const uptime = browserOs.uptime

export function homedir (): string { return VIRTUAL_ROOT }
export function tmpdir (): string { return VIRTUAL_TMPDIR }

export function availableParallelism (): number {
  return Math.max(1, globalThis.navigator?.hardwareConcurrency ?? 1)
}

/** One entry per core, with the model and timings Node would read from the OS left unknown. */
export function cpus (): Array<{ model: string, speed: number, times: { user: number, nice: number, sys: number, idle: number, irq: number } }> {
  return Array.from({ length: availableParallelism() }, () => ({ model: '', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }))
}

// A287: the named-export gaps a bundled CommonJS require()'s namespace needs.
export * from './generated/os.js'

export default nodeModule('os', {
  EOL, arch, availableParallelism, cpus, endianness, freemem, homedir, hostname, loadavg,
  networkInterfaces, platform, release, tmpdir, totalmem, type, uptime
})
