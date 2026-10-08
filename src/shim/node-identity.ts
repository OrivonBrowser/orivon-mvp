// What an app's `process` and `os` say the program is running on: Node, on a
// Linux x64 machine, as the files it sees are (virtual-root.ts: POSIX paths,
// case-sensitive, no drive letters) whatever the host. Passed to
// installGlobals as an option, because that function is serialised into the
// page and may not name a module-level value. The Node version is the one the
// shim's surface is measured against (node-builtin-exports.generated.json),
// so the version an app reads and the members it finds agree.

import { NODE_BUILTIN_EXPORTS } from './node-builtin-exports.js'

export interface NodeIdentity {
  /** `process.versions.node`: no `v`. */
  readonly node: string
  readonly platform: 'linux'
  readonly arch: 'x64'
}

export const NODE_IDENTITY: NodeIdentity = { node: NODE_BUILTIN_EXPORTS.nodeVersion, platform: 'linux', arch: 'x64' }
