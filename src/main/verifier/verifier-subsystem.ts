// Registers the verifier: the resolver rules sending every host a protocol
// serves (a `.eth` name, an `ipfs://` address) to its loopback port, the
// certificate check on every session, and the host process, started once
// the first page has loaded so it never delays the window. Not critical:
// without it every such load fails closed and nothing else changes.

import { join } from 'node:path'
import { app, session, utilityProcess } from 'electron'
import type { Session, WebFrameMain } from 'electron'
import type { Subsystem } from '../registry.js'
import { devEthNames } from '../dev/eth-resolver.js'
import type { HostConfig, LightClientState, SiteProvenance } from '../../protocols/verifier-host/protocol.js'
import type { ContentAddress, PinRecord } from '../../broker/policy/pin.js'
import { servedByVerifier } from '../../loader/fetch/verifier-origin.js'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { PARTITION_HEADER } from '../../loader/fetch/content-root.js'
import { verifierCertificateVerdict } from './certificate-check.js'
import { requestPartition, withPartition } from './partition.js'
import { RUN_LAST, webRequestOwnerFor } from '../sessions/web-request-owner.js'
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
import { checkpointProblem, lightClientView } from './status-view.js'
import type { LightClientView } from './status-view.js'
import { unproxiedGateways } from './proxy-check.js'

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
/** Whether the person has the light client on. Set once the settings are read; until then it is on. */
let enabledByPerson: () => boolean = () => true

/** Lets the person's setting, and not only the environment, switch the light client off. Read when the host starts. */
export function configureVerifier (options: { lightClientEnabled: () => boolean }): void {
  enabledByPerson = options.lightClientEnabled
}

const lightClientSwitchedOff = (): boolean => process.env['ORIVON_ETH_LIGHT_CLIENT'] === 'off' || !enabledByPerson()

function changed (): void {
  for (const listener of listeners) listener()
}

function installCertificateCheck (target: Session): void {
  target.setCertificateVerifyProc((request, callback) => {
    callback(verifierCertificateVerdict(request.hostname, request.certificate.fingerprint, fingerprint, (host) => BUILTIN_ADDRESSES.routesToVerifier(host)))
  })
}

/** Only a request whose host a protocol actually routes to the verifier --
 * the same set `routedSuffixes()` builds Electron's own `{ urls }` filter
 * from, which this reproduces as a predicate: the owner takes no filter of
 * its own (web-request-owner.ts's own header says why). */
function targetsVerifiedHost (url: string): boolean {
  if (!url.startsWith('https://')) return false
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return false
  }
  return BUILTIN_ADDRESSES.routesToVerifier(hostname)
}

/**
 * Stamps every page's request to the verifier with the partition its top-level page
 * owns, and strips whatever a request set itself: a worker's request has no
 * frame, and could otherwise name any partition. Installed on the default
 * session only (see README.md's Design notes for why no other), LAST among
 * `onBeforeSendHeaders` handlers there, so nothing that runs before it --
 * including a future extension rule -- can set or remove this header.
 */
function installPartitionStamp (target: Session): void {
  webRequestOwnerFor(target).onBeforeSendHeaders(RUN_LAST, targetsVerifiedHost, (details, current) => {
    let frame: WebFrameMain | null | undefined
    try {
      frame = details.frame
    } catch {
      frame = undefined
    }
    const partition = requestPartition({ url: details.url, resourceType: details.resourceType, topUrl: frame?.top?.url })
    return { ...current, requestHeaders: withPartition(current.requestHeaders, PARTITION_HEADER, partition) }
  })
}

const SHIPPED_CHECKPOINT = { root: shippedCheckpoint.root, timestamp: slotTimestamp(shippedCheckpoint.slot) }

function verifierStore (): VerifierStore {
  store ??= new VerifierStore(join(app.getPath('userData'), 'verifier'))
  return store
}

/** Chooses again from the shipped and stored checkpoints, so Settings shows the one a restart would use. */
function chooseNow (): CheckpointChoice {
  checkpoint = chooseCheckpoint(SHIPPED_CHECKPOINT, verifierStore().checkpoint(), Math.floor(Date.now() / 1000))
  return checkpoint
}

/** Empty under the test seam: a hermetic run has no real gateways to check
 * a proxy against, and the fallback would only ever add noise there. */
async function unproxiedGatewaysFor (gateways: readonly string[], seamActive: boolean): Promise<string[]> {
  if (seamActive) return []
  return await unproxiedGateways(gateways, async (url) => await app.resolveProxy(url))
}

async function hostConfig (): Promise<HostConfig> {
  const seam = ethTestSeam()
  const stored = verifierStore()
  let lightClient: Pick<HostConfig, 'lightClient' | 'lightClientOff'>
  if (lightClientSwitchedOff()) {
    lightClient = { lightClient: undefined, lightClientOff: 'the Ethereum light client is switched off, so no .eth name can be verified' }
  } else {
    const choice = chooseNow()
    lightClient = choice.ok
      ? { lightClient: { executionRpcs: DEFAULT_ENDPOINTS.executionRpcs, consensusRpc: DEFAULT_ENDPOINTS.consensusRpc, checkpoint: choice.checkpoint.root } }
      : { lightClient: undefined, lightClientOff: `the Ethereum light client cannot start: ${checkpointProblem(choice)}` }
  }
  const gateways = seam?.gateways ?? DEFAULT_ENDPOINTS.gateways
  return {
    port: loopbackPort(),
    ...lightClient,
    gateways,
    unproxiedGateways: await unproxiedGatewaysFor(gateways, seam !== undefined),
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

/**
 * Where a protocol origin's content came from and whether DDOC holds, as a tab
 * showing that origin sees it; null when it is not mounted there or the host
 * is down.
 */
export async function siteProvenance (origin: string): Promise<SiteProvenance | null> {
  if (supervisor === undefined) return null
  try {
    return await supervisor.request({ kind: 'provenance', host: new URL(origin).hostname, partition: origin })
  } catch {
    return null
  }
}

/** How a `.eth` name or an address led to the content this tab shows, for the site-info popover; undefined for any other origin. */
export async function verifierNameEvidence (origin: string, pin: PinRecord | null, servedFromCache: boolean): Promise<NameEvidence | undefined> {
  if (!servedByVerifier(origin)) return undefined
  const live = await siteProvenance(origin)
  const address = BUILTIN_ADDRESSES.servedName(new URL(origin).hostname)?.namespace.endsWith(':') === true
  // An address needs no light client, so its state would explain nothing.
  const unanswered = address ? 'The verifier has not loaded it in this tab yet.' : verifierView().summary
  return chooseNameEvidence(pin?.content, servedFromCache, live, unanswered, Date.now(), address)
}

/**
 * Where an origin's bundle is served from, for the loader: undefined for
 * any origin no protocol serves, and a throw when its name cannot be
 * verified now.
 */
export async function verifierContentAddress (origin: string): Promise<ContentAddress | undefined> {
  if (!servedByVerifier(origin)) return undefined
  if (supervisor === undefined) throw new Error('the verifier has not started')
  // The origin's own partition: the one a tab opening it uses.
  return contentAddressOf(await supervisor.request({ kind: 'mount', host: new URL(origin).hostname, partition: new URL(origin).origin }, MOUNT_TIMEOUT_MS))
}

/** The light client's state in words, for the Settings section and the site-info popover. */
export function verifierView (): LightClientView {
  return lightClientView({
    lightClient,
    checkpoint,
    hostDown,
    switchedOff: lightClientSwitchedOff(),
    endpoints: DEFAULT_ENDPOINTS
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
    app.commandLine.appendSwitch('host-resolver-rules', composeResolverRules({ devClauses: dev.rules, port: loopbackPort(), suffixes: BUILTIN_ADDRESSES.routedSuffixes(), existing }))
    if (dev.secureOrigins !== '') app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', dev.secureOrigins)
    app.on('session-created', installCertificateCheck)
  },
  afterReady: () => {
    installCertificateCheck(session.defaultSession)
    installPartitionStamp(session.defaultSession)
    const host = new HostSupervisor({
      fork: () => utilityProcess.fork(join(__dirname, 'verifier-host.js'), [], { serviceName: 'Orivon verifier' }),
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
        checkpoint: (root, timestamp) => {
          verifierStore().saveCheckpoint({ root, timestamp }, Math.floor(Date.now() / 1000))
          chooseNow()
          changed()
        },
        ipnsSequence: (key, sequence) => { verifierStore().saveIpnsSequence(key, sequence) }
      }
    })
    supervisor = host
    app.on('will-quit', () => { host.stop() })
    startAfterFirstPage(() => { host.start() })
  }
}
