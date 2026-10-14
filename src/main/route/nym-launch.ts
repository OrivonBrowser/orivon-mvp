// What the Nym tunnel needs from Electron, in one place: the utility process it is forked as, where its files are,
// and the proxy check. nym-subsystem.ts holds the rest and runs under plain vitest.

import { join } from 'node:path'
import { app, utilityProcess } from 'electron'
import manifest from '../../../resources/nym-tunnel/nym-tunnel.json'
import { NYM_TUNNEL_IDENTITY } from '../../protocols/nym-tunnel/protocol.js'
import type { NymPrivacy } from '../../protocols/nym-tunnel/protocol.js'
import { envName } from '../../protocols/local-node/protocol.js'
import { nodePort, renewNodePort } from '../verifier/loopback-port.js'
import { locateArtifact } from '../verifier/local-node-artifact.js'
import type { LocalNodeManifest } from '../verifier/local-node-artifact.js'
import { unproxiedGateways } from '../verifier/proxy-check.js'
import { createNymSubsystem } from './nym-subsystem.js'
import type { NymSubsystem } from './nym-subsystem.js'
import { nymTestModule } from './nym-test-seam.js'
import { systemProxyFor } from './system-proxy.js'

const MANIFEST: LocalNodeManifest = manifest

/** The most tunnels the host keeps at once. About 15 MB each beyond the first, README.md of the host has the measurement. */
export const MAX_NYM_TUNNELS = 6

/** The Nym tunnel, stopped when the app quits. The process is forked the first time something asks for it; `privacy` is the saved level and `enabled` the saved switch, which the route service keeps current from then on. */
export function createNym (privacy: NymPrivacy, enabled = true): NymSubsystem {
  const seam = nymTestModule(process.env)
  const made = createNymSubsystem({
    fork: () => utilityProcess.fork(join(__dirname, 'nym-tunnel-host.js'), [], { serviceName: `Orivon ${NYM_TUNNEL_IDENTITY.noun}` }),
    artifact: async () => seam !== undefined
      ? { ok: true, directory: seam.directory }
      : await locateArtifact({ env: process.env, packaged: app.isPackaged, resourcesPath: process.resourcesPath, sourceRoot: app.getAppPath() }, MANIFEST, NYM_TUNNEL_IDENTITY),
    files: () => seam?.files ?? MANIFEST.files,
    // A tunnel that dials around a proxy would show a person's address to Nym's gateways that the proxy was set to hide (T20). The question goes to the system's proxy, never to the default session or `app.setProxy`: with the whole browser on the tunnel those are the tunnel's own front, which Nym itself serves, and asking them would stop Nym from ever starting.
    proxyConfigured: async () => (await unproxiedGateways(['https://example.com/'], systemProxyFor)).length === 0,
    freshPort: () => { renewNodePort(NYM_TUNNEL_IDENTITY.name); return nodePort(NYM_TUNNEL_IDENTITY.name) },
    maxInstances: MAX_NYM_TUNNELS,
    privacy,
    log: process.env[envName(NYM_TUNNEL_IDENTITY.name, 'LOG')] === '1'
  })
  made.setEnabled(enabled)
  app.on('will-quit', () => { made.stop() })
  return made
}

