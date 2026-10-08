// What an app's `process` and `os` say the program is running on: Node, on a
// Linux x64 machine, as the files it sees are (virtual-root.ts: POSIX paths,
// case-sensitive, no drive letters) whatever the host. Passed to
// installGlobals as an option, because that function is serialised into the
// page and may not name a module-level value. The Node version is the one the
// shim's surface is measured against (node-builtin-exports.generated.json),
// so the version an app reads and the members it finds agree.

import { nodeVersion } from './node-builtin-exports.generated.json'

export interface NodeIdentity {
  /** `process.versions.node`: no `v`. */
  readonly node: string
  readonly platform: 'linux'
  /** `os.type()`'s name for the platform. */
  readonly osType: 'Linux'
  readonly arch: 'x64'
}

// A named import, so a bundler keeps this one string and not the generated file's export tables.
export const NODE_IDENTITY: NodeIdentity = { node: nodeVersion, platform: 'linux', osType: 'Linux', arch: 'x64' }
