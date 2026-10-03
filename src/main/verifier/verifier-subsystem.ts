// Registers the verifier: the resolver rules sending every host a protocol
// serves (a `.eth` name, an `ipfs://` address) to its loopback port, the
// certificate check on every session, and the host process, started by the
// first request that needs it (or an address typed that names one) and put to
// sleep once nothing has needed it for a while. Not critical: without it
// every such load fails closed and nothing else changes.

import { join } from 'node:path'
import { app, session, utilityProcess } from 'electron'
import type { Session, WebFrameMain, WebRequestFilter } from 'electron'
import type { Subsystem } from '../registry.js'
import { devEthNames } from '../dev/eth-resolver.js'
import type { HostConfig, LightClientState, SiteProvenance } from '../../protocols/verifier-host/protocol.js'
import type { ContentAddress, PinRecord } from '../../broker/policy/pin.js'
import { servedByVerifier } from '../../loader/fetch/verifier-origin.js'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { PARTITION_HEADER } from '../../loader/fetch/content-root.js'
import { noteCertificate } from '../auth/note-certificate.js'
import { ACCEPT, CHROMIUM_VERDICT, verifierCertificateVerdict } from './certificate-check.js'
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
import { ListeningGate } from './listening-gate.js'
import { ethTestSeam, exposeVerifierStart, noteVerifierListening, verifierStartDelayMs } from './test-seam.js'
import { VerifierStore } from './verifier-store.js'
import { chooseNameEvidence } from './name-evidence.js'
import type { NameEvidence } from './name-evidence.js'
import { checkpointProblem, lightClientView } from './status-view.js'
import type { LightClientView } from './status-view.js'
import { unproxiedGateways } from './proxy-check.js'
import { HostLifecycle } from './host-lifecycle.js'
import { anyTabOnVerifiedOrigin } from './tab-on-verified-origin.js'
import type { TabsOfWindow } from './tab-on-verified-origin.js'
import { provideVerifierAccess } from './verifier-access.js'

/** Mounting may wait for the light client to sync, then resolve a name and follow its pointers. */
const MOUNT_TIMEOUT_MS = 30_000
/** How long a request to a verifier-served host waits for the host to listen: about three times the slowest start measured (3 s), so a host that never answers still ends in the ordinary error. */
const LISTEN_WAIT_MS = 10_000

let fingerprint: string | undefined
let supervisor: HostSupervisor | undefined
let store: VerifierStore | undefined
let lightClient: LightClientState = { state: 'off' }
let checkpoint: CheckpointChoice | undefined
let hostDown: string | undefined
/** No host process runs and nothing failed: it has not been needed yet, or it slept after going unused. */
let hostAsleep = true
const listeningGate = new ListeningGate(LISTEN_WAIT_MS)
/** Asks for the host: starts it if it is not running and restarts its idle wait. */
let startHost: () => void = () => {}
/** Whether any open tab shows an origin the verifier serves; set once the shell's windows exist. */
let tabsOnVerifiedOrigin: () => boolean = () => false
const listeners = new Set<() => void>()
/** Whether the person has the light client on. Set once the settings are read; until then it is on. */
let enabledByPerson: () => boolean = () => true

/** Lets the person's setting, and not only the environment, switch the light client off. Read once, here, at launch:
 * the choice applies from Orivon's next start, as Settings says, however often the host sleeps and wakes before it. */
export function configureVerifier (options: { lightClientEnabled: () => boolean, windows: () => readonly TabsOfWindow[], servedFromCache: (origin: string) => boolean }): void {
  const enabledAtLaunch = options.lightClientEnabled()
  enabledByPerson = () => enabledAtLaunch
  tabsOnVerifiedOrigin = () => anyTabOnVerifiedOrigin(options.windows(), options.servedFromCache)
}

const lightClientSwitchedOff = (): boolean => process.env['ORIVON_ETH_LIGHT_CLIENT'] === 'off' || !enabledByPerson()

function changed (): void {
  for (const listener of listeners) listener()
}

function installCertificateCheck (target: Session): void {
  target.setCertificateVerifyProc((request, callback) => {
    const verdict = verifierCertificateVerdict(request.hostname, request.certificate.fingerprint, fingerprint, (host) => BUILTIN_ADDRESSES.routesToVerifier(host))
    // Only a connection that was accepted can describe the page that loaded: Chromium's own checks passed, or the verifier's certificate matched.
    noteCertificate(request.hostname, verdict === ACCEPT || (verdict === CHROMIUM_VERDICT && request.errorCode === 0), request.validatedCertificate, request.certificate)
    callback(verdict)
  })
}

/** Only a request whose host a protocol actually routes to the verifier --
 * `verifiedHostFilter` below builds Electron's own coarse `{ urls }` filter
 * from the same `routedSuffixes()`, so this is the precise check the owner
 * runs on whatever that filter already let through. */
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

/** Electron's own `{ urls }` filter for `installPartitionStamp` below --
 * `*.` matches a suffix's own bare host as well as any subdomain (Chromium's
 * match-pattern syntax), covering exactly what `routesToVerifier` (and so
 * `targetsVerifiedHost` above) accepts. */
function verifiedHostFilter (): WebRequestFilter {
  return { urls: BUILTIN_ADDRESSES.routedSuffixes().map((suffix) => `https://*.${suffix}/*`) }
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
  webRequestOwnerFor(target).onBeforeSendHeaders(RUN_LAST, verifiedHostFilter(), targetsVerifiedHost, (details, current) => {
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

/**
 * Holds a request to a verifier-served host until the host listens, so a
 * page opened in the first moments after launch loads instead of landing on
 * the connection-refused page. Default session only, like the stamp above:
 * the other sessions that reach the verifier register their own handlers.
 */
function installListeningGate (target: Session): void {
  webRequestOwnerFor(target).onBeforeRequest(0, verifiedHostFilter(), targetsVerifiedHost, async (_details, current) => {
    startHost()
    await listeningGate.whenSettled()
    return current
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

/**
 * Whether the default session has no proxy in front of it at all, checked
 * against a generic https URL rather than a real gateway: a CCIP-Read
 * destination is a name's own resolver contract's choice, not known until
 * long after the host has already started, so nothing narrower exists to
 * check yet. Reuses `unproxiedGateways`'s own timeout and fail-closed
 * (proxied) direction -- a check that cannot answer must never make
 * `guardedCcipRequest` go around a proxy that is actually there. `false`
 * (treated as proxied) under the test seam, same reasoning as
 * `unproxiedGatewaysFor`.
 */
async function ccipDirectFor (seamActive: boolean): Promise<boolean> {
  if (seamActive) return false
  const unproxied = await unproxiedGateways(['https://example.com/'], async (url) => await app.resolveProxy(url))
  return unproxied.length > 0
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
    ccipDirect: await ccipDirectFor(seam !== undefined),
    ipnsNameServices: seam === undefined ? DEFAULT_ENDPOINTS.ipnsNameServices : [],
    dnsOverHttps: seam?.dnsOverHttps ?? DEFAULT_ENDPOINTS.dnsOverHttps,
    ipnsSequences: stored.ipnsSequences(),
    ...(seam === undefined ? {} : { fixtures: seam.fixtures })
  }
}

/** The age of the newest checkpoint the light client could start from; undefined while it is off or none can start it. */
function usableCheckpointAge (): number | undefined {
  if (lightClientSwitchedOff()) return undefined
  const choice = chooseNow()
  return choice.ok ? choice.ageSeconds : undefined
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
  startHost()
  await listeningGate.whenSettled()
  if (supervisor === undefined) throw new Error('the verifier has not started')
  // The origin's own partition: the one a tab opening it uses.
  return contentAddressOf(await supervisor.request({ kind: 'mount', host: new URL(origin).hostname, partition: new URL(origin).origin }, MOUNT_TIMEOUT_MS))
}

/** The light client's state in words, for the Settings section and the site-info popover. */
export function verifierView (): LightClientView {
  return lightClientView({
    lightClient,
    // A sleeping host reports no newer checkpoint, so the one it would start from is chosen again at the age it has now.
    checkpoint: hostAsleep || checkpoint === undefined ? chooseNow() : checkpoint,
    hostDown,
    hostAsleep: hostAsleep && hostDown === undefined,
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
  afterReady: (ctx) => {
    installCertificateCheck(session.defaultSession)
    installPartitionStamp(session.defaultSession)
    installListeningGate(session.defaultSession)
    const host = new HostSupervisor({
      fork: () => utilityProcess.fork(join(__dirname, 'verifier-host.js'), [], { serviceName: 'Orivon verifier' }),
      config: hostConfig,
      events: {
        starting: () => {
          hostAsleep = false
          listeningGate.starting()
          changed()
        },
        idle: () => {
          fingerprint = undefined
          hostDown = undefined
          hostAsleep = true
          lightClient = { state: 'off' }
          noteVerifierListening(false)
          // Whoever asks next starts it, and waits for it to listen.
          listeningGate.starting()
          changed()
        },
        listening: (value) => {
          fingerprint = value
          hostDown = undefined
          hostAsleep = false
          noteVerifierListening(true)
          listeningGate.listening()
          changed()
        },
        down: (reason) => {
          fingerprint = undefined
          hostAsleep = false
          hostDown = reason
          noteVerifierListening(false)
          listeningGate.down()
          console.error(`[verifier] ${reason}`)
          changed()
        },
        status: (value) => {
          lightClient = value
          changed()
        },
        checkpoint: (root, timestamp) => {
          try {
            verifierStore().saveCheckpoint({ root, timestamp }, Math.floor(Date.now() / 1000))
          } catch (error) {
            // A full or read-only profile: the checkpoint is fetched again by a later run.
            console.error('[verifier] could not keep the new checkpoint:', error)
          }
          chooseNow()
          changed()
        },
        ipnsSequence: (key, sequence) => { verifierStore().saveIpnsSequence(key, sequence) }
      }
    })
    supervisor = host
    const lifecycle = new HostLifecycle({
      start: () => { host.start() },
      idle: () => { host.idle() },
      tabShowsVerifiedOrigin: () => tabsOnVerifiedOrigin(),
      checkpointAgeSeconds: usableCheckpointAge,
      startDelayMs: verifierStartDelayMs,
      privateSession: ctx.privateSession
    })
    startHost = () => { lifecycle.request() }
    provideVerifierAccess({ start: () => { startHost() }, ready: async () => { await listeningGate.whenSettled() } })
    exposeVerifierStart(() => { startHost() })
    lifecycle.refreshAtLaunch()
    app.on('will-quit', () => {
      lifecycle.dispose()
      host.stop()
      // Blocking on purpose: nothing after `will-quit` can be awaited, so an
      // async write here would race process exit and lose whatever the
      // debounce had not yet flushed, the same as a crash would.
      store?.flushSync()
    })
  }
}
