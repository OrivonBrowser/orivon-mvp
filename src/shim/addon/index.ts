// Native addons for ported code: Node's `process.dlopen`, installed on the
// shim's process when this module loads, over loadAddon. The `module`
// target's createRequire (../polyfills/module.ts) is the other route in.

import { loadAddon, preloadAddon } from './load.js'

export { loadAddon, preloadAddon }

/** Node's process.dlopen: `module.exports` becomes the addon's exports. */
export function dlopen (module: { exports: unknown }, filename: string, _flags?: number): void {
  module.exports = loadAddon(filename)
}

// A plain assignment, replaceable by the app, as every shim global is (ADR-0021).
const proc = (globalThis as { process?: { dlopen?: unknown } }).process
if (proc !== undefined && proc.dlopen === undefined) proc.dlopen = dlopen
