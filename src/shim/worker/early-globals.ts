// Installs the shim's process, global and setImmediate on the Worker before
// any other module of the runtime evaluates: runtime.ts imports this first,
// because polyfills in its graph read `process` while they load, as they do
// in an app tab, where the preload installs it before any app script runs.

import { installGlobals } from '../globals.js'
import type { GlobalsTarget } from '../globals-types.js'
import { NODE_IDENTITY } from '../node-identity.js'
import { VIRTUAL_ROOT, VIRTUAL_TMPDIR } from '../virtual-root.js'

installGlobals({ root: VIRTUAL_ROOT, tmpdir: VIRTUAL_TMPDIR, node: NODE_IDENTITY }, globalThis as unknown as GlobalsTarget)
