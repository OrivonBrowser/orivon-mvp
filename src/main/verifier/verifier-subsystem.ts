// Registers the `.eth` verifier: the resolver rules sending every `.eth`
// name to its loopback port, the certificate check on every session, and
// the host process, started once the first page has loaded so it never
// delays the window. Not critical: without it every `.eth` load fails
// closed and nothing else changes.

import { join } from 'node:path'
import { app, session, utilityProcess } from 'electron'
import type { Session } from 'electron'
import type { Subsystem } from '../registry.js'
import { readDevEthNames } from '../dev/eth-resolver.js'
import type { HostConfig, LightClientState, SiteProvenance } from '../../verifier-host/protocol.js'
import { ethCertificateVerdict } from './certificate-check.js'
import { chooseCheckpoint, slotTimestamp } from './checkpoint.js'
import type { CheckpointChoice } from './checkpoint.js'
import { DEFAULT_ENDPOINTS } from './endpoints.js'
import { HostSupervisor } from './host-supervisor.js'
import { loopbackPort } from './loopback-port.js'
import shippedCheckpoint from './mainnet-checkpoint.json'
import { composeResolverRules } from './resolver-rules.js'
import { ethTestSeam } from './test-seam.js'
import { VerifierStore } from './verifier-store.js'

/** Started this long after ready at the latest, if no page has finished loading by then. */
const START_FALLBACK_MS = 3_000

let fingerprint: string | undefined
let supervisor: HostSupervisor | undefined
let store: VerifierStore | undefined
let lightClient: LightClientState = { state: 'off' }
let checkpoint: CheckpointChoice | undefined
let hostDown: string | undefined = 'not started yet'

function installCertificateCheck (target: Session): void {
  target.setCertificateVerifyProc((request, callback) => {
    callback(ethCertificateVerdict(request.hostname, request.certificate.fingerprint, fingerprint))
  })
}

function hostConfig (): HostConfig {
  const seam = ethTestSeam()
  const stored = store ?? new VerifierStore(join(app.getPath('userData'), 'verifier'))
  store = stored
  let lightClientConfig: HostConfig['lightClient']
  if (process.env['ORIVON_ETH_LIGHT_CLIENT'] !== 'off') {
    checkpoint = chooseCheckpoint({ root: shippedCheckpoint.root, timestamp: slotTimestamp(shippedCheckpoint.slot) }, stored.checkpoint(), Math.floor(Date.now() / 1000))
    if (checkpoint.ok) lightClientConfig = { executionRpc: DEFAULT_ENDPOINTS.executionRpc, consensusRpc: DEFAULT_ENDPOINTS.consensusRpc, checkpoint: checkpoint.checkpoint.root }
  }
  return {
    port: loopbackPort(),
    lightClient: lightClientConfig,
    gateways: seam?.gateways ?? DEFAULT_ENDPOINTS.gateways,
    ipnsNameServices: seam === undefined ? DEFAULT_ENDPOINTS.ipnsNameServices : [],
    dnsOverHttps: seam?.dnsOverHttps ?? DEFAULT_ENDPOINTS.dnsOverHttps,
    ipnsSequences: stored.ipnsSequences(),
    ...(seam === undefined ? {} : { fixtures: seam.fixtures })
  }
}

function startAfterFirstPage (start: () => void): void {
  let started = false
  const once = (): void => {
    if (started) return
    started = true
    start()
  }
  app.once('web-contents-created', (_event, contents) => { contents.once('did-finish-load', once) })
  setTimeout(once, START_FALLBACK_MS).unref()
}

/** Where a `.eth` site's content came from and whether DDOC holds, or null when it is not mounted or the host is down. */
export async function siteProvenance (host: string): Promise<SiteProvenance | null> {
  if (supervisor === undefined) return null
  try {
    return await supervisor.request({ kind: 'provenance', host })
  } catch {
    return null
  }
}

export interface VerifierStatus {
  readonly lightClient: LightClientState
  readonly checkpoint: CheckpointChoice | undefined
  readonly hostDown: string | undefined
}

export function verifierStatus (): VerifierStatus {
  return { lightClient, checkpoint, hostDown }
}

export const verifierSubsystem: Subsystem = {
  name: 'verifier',
  beforeReady: () => {
    const dev = readDevEthNames()
    const existing = app.commandLine.getSwitchValue('host-resolver-rules')
    app.commandLine.appendSwitch('host-resolver-rules', composeResolverRules({ devClauses: dev.rules, port: loopbackPort(), existing }))
    if (dev.secureOrigins !== '') app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', dev.secureOrigins)
    app.on('session-created', installCertificateCheck)
  },
  afterReady: () => {
    installCertificateCheck(session.defaultSession)
    const host = new HostSupervisor({
      fork: () => utilityProcess.fork(join(__dirname, 'verifier-host.js'), [], { serviceName: 'Orivon .eth verifier' }),
      config: hostConfig,
      events: {
        listening: (value) => {
          fingerprint = value
          hostDown = undefined
        },
        down: (reason) => {
          fingerprint = undefined
          hostDown = reason
          console.error(`[verifier] ${reason}`)
        },
        status: (value) => { lightClient = value },
        checkpoint: (root, timestamp) => { store?.saveCheckpoint({ root, timestamp }) },
        ipnsSequence: (key, sequence) => { store?.saveIpnsSequence(key, sequence) }
      }
    })
    supervisor = host
    app.on('will-quit', () => { host.stop() })
    startAfterFirstPage(() => { host.start() })
  }
}
