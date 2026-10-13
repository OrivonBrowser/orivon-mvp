// Keeps every page away from the ports local nodes listen on. A node's HTTP API is a
// loopback server that reads and keeps what it fetched, so a page that could ask it
// would learn from how fast it answers what other sites this computer has opened. Every
// request to such a port, from any tab, app or frame in any session, is cancelled before
// it connects. The verifier host reads the node from a utility process, which is no
// session, so it is unaffected. Registered through the web-request owner, never a raw
// `session.webRequest.onBeforeRequest`, which would replace a sibling's listener.

import { app, session } from 'electron'
import type { Session } from 'electron'
import { forEachAppSession } from '../../loader/electron/serve.js'
import type { Subsystem } from '../registry.js'
import { heldNodePorts } from '../verifier/loopback-port.js'
import { LOOPBACK_URL_PATTERNS, reachesLocalNode } from './local-node-ports.js'
import { webRequestOwnerFor } from './web-request-owner.js'

const gated = new WeakSet<Session>()

/** Registers the gate on `target`, once. */
export function installLocalNodePortGate (target: Session, ports: () => ReadonlySet<number> = heldNodePorts): void {
  if (gated.has(target)) return
  gated.add(target)
  webRequestOwnerFor(target).onBeforeRequest(0, { urls: [...LOOPBACK_URL_PATTERNS] }, () => true, async (details, current) =>
    reachesLocalNode(details.url, ports()) ? { ...current, cancel: true } : current)
}

export const localNodePortGateSubsystem: Subsystem = {
  name: 'local-node-port-gate',
  // Without it a page can time a node's store.
  critical: true,
  beforeReady: () => {
    app.on('session-created', (created) => { installLocalNodePortGate(created) })
  },
  afterReady: () => {
    installLocalNodePortGate(session.defaultSession)
    forEachAppSession((appSession) => { installLocalNodePortGate(appSession) })
  }
}
