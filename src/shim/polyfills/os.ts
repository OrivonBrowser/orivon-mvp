// `os` module target (module-map.ts): os-browserify's answers, with homedir()
// and tmpdir() moved to the virtual root every other Node-shaped path agrees
// on (virtual-root.ts), and cpus() sized from the browser's own core count
// rather than os-browserify's empty array, since `os.cpus().length` is how
// Node code sizes a worker pool.

import browserOs from 'os-browserify/browser.js'
import { nodeModule } from './module-proxy.js'
import { VIRTUAL_ROOT, VIRTUAL_TMPDIR } from '../virtual-root.js'

export const EOL = browserOs.EOL
export const arch = browserOs.arch
export const endianness = browserOs.endianness
export const freemem = browserOs.freemem
export const hostname = browserOs.hostname
export const loadavg = browserOs.loadavg
export const networkInterfaces = browserOs.networkInterfaces
export const platform = browserOs.platform
export const release = browserOs.release
export const totalmem = browserOs.totalmem
export const type = browserOs.type
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

export default nodeModule('os', {
  EOL, arch, availableParallelism, cpus, endianness, freemem, homedir, hostname, loadavg,
  networkInterfaces, platform, release, tmpdir, totalmem, type, uptime
})
