// What a local node needs from Electron, in one place: the utility process it
// is forked as, where its files are, the proxy check, and its data directory.
// A node's own subsystem (local-node-subsystem.ts) says only which kind it is,
// which port it listens on and when a test build serves it otherwise.

import { join } from 'node:path'
import { app, utilityProcess } from 'electron'
import type { NodeIdentity } from '../../protocols/local-node/kind.js'
import { LocalNodeController } from './local-node-controller.js'
import { locateArtifact } from './local-node-artifact.js'
import type { LocalNodeManifest } from './local-node-artifact.js'
import { unproxiedGateways } from './proxy-check.js'

export interface LocalNodeSpec {
  readonly kind: NodeIdentity
  readonly manifest: LocalNodeManifest
  /** The loopback port the node's API listens on; the same until its port is taken. */
  readonly apiPort: () => number
  /** The node could not bind its port: choose another for the next start, and tell whoever fixed the old one in place. */
  readonly apiPortTaken: () => void
  /** Why the node must not start in this build, in words, or undefined. */
  readonly disabled?: () => string | undefined
  /** What the person chose that the node's arguments follow, read at each start. */
  readonly options?: () => Readonly<Record<string, string>>
}

/** The controller of a node, stopped when the app quits. The process is forked the first time something asks for the node. */
export function createLocalNodeController (spec: LocalNodeSpec): LocalNodeController {
  const made = new LocalNodeController({
    kind: spec.kind,
    fork: () => utilityProcess.fork(join(__dirname, 'local-node-host.js'), [], { serviceName: `Orivon ${spec.kind.noun}` }),
    artifact: async () => await locateArtifact({ env: process.env, packaged: app.isPackaged, resourcesPath: process.resourcesPath, sourceRoot: app.getAppPath() }, spec.manifest, spec.kind),
    // A node that dials around a proxy would show a person's address to its peers that the proxy was set to hide (T20).
    proxyConfigured: async () => (await unproxiedGateways(['https://example.com/'], async (url) => await app.resolveProxy(url))).length === 0,
    ...(spec.disabled === undefined ? {} : { disabled: spec.disabled }),
    ...(spec.options === undefined ? {} : { options: spec.options }),
    apiPort: spec.apiPort,
    dataDir: () => join(app.getPath('userData'), spec.kind.name),
    files: spec.manifest.files,
    apiPortTaken: spec.apiPortTaken,
    componentName: spec.manifest.name
  })
  app.on('will-quit', () => { made.stop() })
  return made
}
