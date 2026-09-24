// Registers the `.eth` verifier: the resolver rules sending every `.eth`
// name to its loopback port, the certificate check on every session, and
// the host process, started once the first page has loaded so it never
// delays the window. Not critical: without it every `.eth` load fails
// closed and nothing else changes.

import { join } from 'node:path'
import { app, session, utilityProcess } from 'electron'
import type { Session } from 'electron'
import type { Subsystem } from '../registry.js'
import { devEthNames } from '../dev/eth-resolver.js'
import type { HostConfig, LightClientState, SiteProvenance } from '../../verifier-host/protocol.js'
import type { ContentAddress, PinRecord } from '../../broker/policy/pin.js'
import { servedByVerifier } from '../../loader/eth-origin.js'
import { ethCertificateVerdict } from './certificate-check.js'
import { contentAddressOf } from './content-address.js'
import { chooseCheckpoint, slotTimestamp } from './checkpoint.js'
import type { CheckpointChoice } from './checkpoint.js'
import { DEFAULT_ENDPOINTS } from './endpoints.js'
import { HostSupervisor } from './host-supervisor.js'
import { loopbackPort } from './loopback-port.js'
import shippedCheckpoint from './mainnet-checkpoint.json'
import { composeResolverRules } from './resolver-rules.js'
import { ethTestSeam, noteVerifierListening } from './test-seam.js'
import { VerifierStore } from './verifier-store.js'
import { chooseNameEvidence } from './name-evidence.js'
import type { NameEvidence } from './name-evidence.js'
import { lightClientView } from './status-view.js'
import type { LightClientView } from './status-view.js'

/** Started this long after ready at the latest, if no page has finished loading by then. */
const START_FALLBACK_MS = 3_000
/** Mounting may wait for the light client to sync, then resolve a name and follow its pointers. */
const MOUNT_TIMEOUT_MS = 30_000

let fingerprint: string | undefined
let supervisor: HostSupervisor | undefined
let store: VerifierStore | undefined
let lightClient: LightClientState = { state: 'off' }
let checkpoint: CheckpointChoice | undefined
let hostDown: string | undefined = 'not started yet'
const listeners = new Set<() => void>()

function changed (): void {
  for (const listener of listeners) listener()
}

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
    if (checkpoint.ok) lightClientConfig = { executionRpcs: DEFAULT_ENDPOINTS.executionRpcs, consensusRpc: DEFAULT_ENDPOINTS.consensusRpc, checkpoint: checkpoint.checkpoint.root }
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

/** How a `.eth` name led to the content this tab shows, for the site-info popover; undefined for any other origin. */
export async function ethNameEvidence (origin: string, pin: PinRecord | null, servedFromCache: boolean): Promise<NameEvidence | undefined> {
  if (!servedByVerifier(origin)) return undefined
  const live = await siteProvenance(new URL(origin).hostname)
  return chooseNameEvidence(pin?.content, servedFromCache, live, verifierView().summary, Date.now())
}

/**
 * Where an origin's bundle is served from, for the loader: undefined for
 * any origin that is not a `.eth` name, and a throw when the name cannot be
 * verified now.
 */
export async function ethContentAddress (origin: string): Promise<ContentAddress | undefined> {
  if (!servedByVerifier(origin)) return undefined
  if (supervisor === undefined) throw new Error('the .eth verifier has not started')
  return contentAddressOf(await supervisor.request({ kind: 'mount', host: new URL(origin).hostname }, MOUNT_TIMEOUT_MS))
}

/** The light client's state in words, for the Settings section and the site-info popover. */
export function verifierView (): LightClientView {
  return lightClientView({
    lightClient,
    checkpoint,
    hostDown,
    switchedOff: process.env['ORIVON_ETH_LIGHT_CLIENT'] === 'off',
    endpoints: { executionRpcs: DEFAULT_ENDPOINTS.executionRpcs, consensusRpc: DEFAULT_ENDPOINTS.consensusRpc, gateways: DEFAULT_ENDPOINTS.gateways }
  }, Date.now())
}

/** Called whenever what verifierView() says may have changed; returns the unsubscribe. */
export function onVerifierChange (listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const verifierSubsystem: Subsystem = {
  name: 'verifier',
  beforeReady: () => {
    const dev = devEthNames()
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
          noteVerifierListening(true)
          changed()
        },
        down: (reason) => {
          fingerprint = undefined
          hostDown = reason
          noteVerifierListening(false)
          console.error(`[verifier] ${reason}`)
          changed()
        },
        status: (value) => {
          lightClient = value
          changed()
        },
        checkpoint: (root, timestamp) => { store?.saveCheckpoint({ root, timestamp }) },
        ipnsSequence: (key, sequence) => { store?.saveIpnsSequence(key, sequence) }
      }
    })
    supervisor = host
    app.on('will-quit', () => { host.stop() })
    startAfterFirstPage(() => { host.start() })
  }
}
