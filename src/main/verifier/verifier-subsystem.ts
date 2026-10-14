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
import { devEthNames, isDevEthName } from '../dev/eth-resolver.js'
import type { HostConfig, LightClientState, SiteProvenance } from '../../protocols/verifier-host/protocol.js'
import type { ContentAddress, PinRecord } from '../../broker/policy/pin.js'
import { servedByVerifier } from '../../loader/fetch/verifier-origin.js'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { PARTITION_HEADER, ROUTE_HEADER } from '../../loader/fetch/content-root.js'
import { noteCertificate } from '../auth/note-certificate.js'
import { ACCEPT, CHROMIUM_VERDICT, REJECT, refusalNote, verifierCertificateVerdict } from './certificate-check.js'
import { installPartitionStamp, targetsVerifiedHost, verifiedHostFilter } from './partition-stamp.js'
import { RUN_LAST, webRequestOwnerFor } from '../sessions/web-request-owner.js'
import { forEachWebsiteSession } from '../sessions/website-sessions.js'
import { contentAddressOf } from './content-address.js'
import { chooseCheckpoint, MAX_CHECKPOINT_AGE_SECONDS, slotTimestamp } from './checkpoint.js'
import type { CheckpointChoice } from './checkpoint.js'
import { DEFAULT_ENDPOINTS } from './endpoints.js'
import { HostSupervisor } from './host-supervisor.js'
import type { ProcessInfo } from './process-supervisor.js'
import { loopbackPort } from './loopback-port.js'
import shippedCheckpoint from './mainnet-checkpoint.json'
import { composeResolverRules } from './resolver-rules.js'
import { ListeningGate } from './listening-gate.js'
import { announceNameSchemeChange } from './name-scheme-events.js'
import type { EthTestSeam } from './test-seam.js'
import { ethTestSeam, exposeVerifierStart, noteVerifierListening, verifierStartDelayMs } from './test-seam.js'
import { VerifierStore } from './verifier-store.js'
import { chooseNameEvidence } from './name-evidence.js'
import type { NameEvidence } from './name-evidence.js'
import { checkpointProblem, lightClientView } from './status-view.js'
import type { LightClientView } from './status-view.js'
import { ccipDirectFor, tunnelFront, tunnelProfileFront, unproxiedGatewaysFor } from './host-proxy.js'
import { HostLifecycle } from './host-lifecycle.js'
import { anyTabOnVerifiedOrigin } from './tab-on-verified-origin.js'
import type { TabsOfWindow } from './tab-on-verified-origin.js'
import { provideVerifierAccess } from './verifier-access.js'
import { configureSwarmNode, swarmNode, swarmNodeEndpoint, swarmNodeState } from './swarm-node-subsystem.js'
import { configureIpfsNode, ipfsNode, ipfsNodeEndpoint, ipfsNodeState } from './ipfs-node-subsystem.js'
import type { LocalNodeSubsystem } from './local-node-subsystem.js'
import { IPFS_NODE_IDENTITY } from '../../protocols/ipfs-node/protocol.js'
import { SWARM_NODE_IDENTITY } from '../../protocols/swarm-node/protocol.js'
import type { NodeNotice } from '../../protocols/verifier-host/protocol.js'
import type { RouteService } from '../route/route-service.js'

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
/** The nodes the host may ask for, by name. */
const NODES: ReadonlyMap<string, LocalNodeSubsystem> = new Map([[SWARM_NODE_IDENTITY.name, swarmNode], [IPFS_NODE_IDENTITY.name, ipfsNode]])
/** The node asks being answered, which later asks for the same node share. */
const asking = new Map<string, Promise<unknown>>()
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
/** Where the person reads IPFS from, and whether the node may ask a lookup service. Read at each host start, so a change reaches the next. Until the settings are read, the defaults. */
let ipfsSourceChoice: () => 'node' | 'gateways' = () => 'node'
let ipfsLookupServiceChoice: () => boolean = () => true
/** Puts the host to sleep so that its next request rebuilds its config. Set once the host exists. */
let idleHost: () => void = () => {}
/** The routes, published after this subsystem starts: read when the host's config is built. */
let routesOf: () => RouteService | undefined = () => undefined

/**
 * The browser-wide tunnel setting changed: the host's direct routes and its fetch are decided when it starts (whether a proxy
 * applies is read once, and the front it signs in to is part of its config), so it sleeps and its next request rebuilds them.
 * The local nodes stop with it.
 */
export function tunnelDefaultChanged (): void {
  idleHost()
  // Also when the host was not running: a node started for an earlier ask keeps dialling until it is stopped.
  for (const node of NODES.values()) node.verifierIdle()
  changed()
}

/** Lets the person's setting, and not only the environment, switch the light client off. Read each time the host builds its config and each time a view is drawn, so a change reaches the next start; `lightClientSettingChanged` makes that next start now. */
export function configureVerifier (options: { lightClientEnabled: () => boolean, windows: () => readonly TabsOfWindow[], servedFromCache: (origin: string) => boolean, ipfsSource?: () => 'node' | 'gateways', ipfsLookupService?: () => boolean, swarmNodeEnabled?: () => boolean }): void {
  if (options.ipfsSource !== undefined) ipfsSourceChoice = options.ipfsSource
  if (options.ipfsLookupService !== undefined) ipfsLookupServiceChoice = options.ipfsLookupService
  configureIpfsNode({ lookupService: () => ipfsLookupServiceChoice() })
  if (options.swarmNodeEnabled !== undefined) configureSwarmNode({ enabled: options.swarmNodeEnabled })
  enabledByPerson = options.lightClientEnabled
  tabsOnVerifiedOrigin = () => anyTabOnVerifiedOrigin(options.windows(), options.servedFromCache)
}

/**
 * The person changed an IPFS setting: applied at once. The source decides the host's config, so the host sleeps and its
 * next request rebuilds it. The lookup service only decides the node's arguments, so only the node stops, and the
 * light client, the mounted sites and the Swarm node are left alone; the node's next start has the new arguments, and
 * a running host is told whether a name service may be asked for an IPNS record.
 */
export function ipfsSettingsChanged (setting: 'source' | 'lookupService'): void {
  ipfsNode.verifierIdle()
  if (setting === 'source') idleHost()
  // A running host asks a name service for an IPNS record only while the lookup service is allowed.
  else supervisor?.send({ type: 'ipfs-lookup', allowed: ipfsLookupServiceChoice() })
  changed()
}

/**
 * The person switched the light client on or off: applied at once. The host builds its config when it starts, so it sleeps
 * and its next request rebuilds it with the new choice; the IPFS and Swarm nodes it reads from are left running, and a
 * `.eth` page open now says why it cannot load until the light client is on again.
 */
export function lightClientSettingChanged (): void {
  idleHost()
  changed()
}

/**
 * Clearing cached data or all history: the IPFS node stops and its block store is deleted, and the salt its partition
 * keys are made with is replaced, so nothing it kept about the sites visited can be read back or asked for.
 */
export async function forgetIpfsNodeData (): Promise<void> {
  await ipfsNode.forget()
  verifierStore().rotatePartitionSalt()
  // The host holds the old salt from its start; its next request rebuilds its config with the new one.
  idleHost()
}

const lightClientSwitchedOff = (): boolean => process.env['ORIVON_ETH_LIGHT_CLIENT'] === 'off' || !enabledByPerson()

function changed (): void {
  for (const listener of listeners) listener()
}

function installCertificateCheck (target: Session): void {
  target.setCertificateVerifyProc((request, callback) => {
    const verdict = verifierCertificateVerdict(request.hostname, request.certificate.fingerprint, fingerprint, (host) => BUILTIN_ADDRESSES.routesToVerifier(host))
    if (verdict === REJECT) console.error(refusalNote(request.hostname, request.certificate.fingerprint, fingerprint, hostDown !== undefined ? `down: ${hostDown}` : hostAsleep ? 'asleep' : 'running'))
    // Only a connection that was accepted can describe the page that loaded: Chromium's own checks passed, or the verifier's certificate matched.
    noteCertificate(request.hostname, verdict === ACCEPT || (verdict === CHROMIUM_VERDICT && request.errorCode === 0), request.validatedCertificate, request.certificate)
    callback(verdict)
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

/** The Bee-API origins Swarm reads from: the node Orivon runs, unless a test build names its own. */
function swarmEndpoints (seam: EthTestSeam | undefined): readonly string[] {
  return seam === undefined ? [swarmNodeEndpoint()] : seam.swarmEndpoints ?? []
}

/** The nodes' own endpoints, by the name the popover gives them: only an ordinary build runs them (a test build's endpoints are fixtures and keep their own address). */
function nodeEndpointNames (): Readonly<Record<string, string>> {
  if (ethTestSeam() !== undefined) return {}
  return { [ipfsNodeEndpoint()]: "Orivon's IPFS node", [swarmNodeEndpoint()]: "Orivon's Swarm node" }
}

/** Whether IPFS is read from the node Orivon runs: the person's choice, never in a test build, which serves IPFS from its own endpoints. */
function ipfsFromNode (seam: EthTestSeam | undefined): boolean {
  return seam === undefined && ipfsSourceChoice() === 'node'
}

async function hostConfig (): Promise<HostConfig> {
  const seam = ethTestSeam()
  const front = await tunnelFront(routesOf())
  const profileFront = await tunnelProfileFront(routesOf())
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
    // Through the tunnel nothing is reached around it, whatever the proxy check answers.
    unproxiedGateways: front === undefined ? await unproxiedGatewaysFor(gateways, seam !== undefined) : [],
    ccipDirect: front === undefined && await ccipDirectFor(seam !== undefined),
    ...(front === undefined ? {} : { front }),
    ...(profileFront === undefined ? {} : { profileFront }),
    ipnsNameServices: seam === undefined ? DEFAULT_ENDPOINTS.ipnsNameServices : [],
    dnsOverHttps: seam?.dnsOverHttps ?? DEFAULT_ENDPOINTS.dnsOverHttps,
    ipnsSequences: stored.ipnsSequences(),
    swarmEndpoints: swarmEndpoints(seam),
    ...(seam === undefined && { swarmNode: true }),
    ...(ipfsFromNode(seam) && { ipfsNode: { endpoint: ipfsNodeEndpoint(), partitionSalt: stored.partitionSalt(), lookupService: ipfsLookupServiceChoice() } }),
    swarmFeedIndexes: stored.swarmFeedIndexes(),
    ...(seam === undefined ? {} : { fixtures: seam.fixtures })
  }
}

/** `tunnel` when the website at `origin` lives in the tunnel profile: its name is then proved, and its files read, only through the tunnel. */
function routeOf (origin: string): { readonly route?: 'tunnel' } {
  return routesOf()?.hub.profileFor(origin) === 'tunnel' ? { route: 'tunnel' } : {}
}

/** The age of the newest checkpoint the light client could start from; undefined while it is off or none can start it. */
function usableCheckpointAge (): number | undefined {
  if (lightClientSwitchedOff()) return undefined
  const choice = chooseNow()
  return choice.ok ? choice.ageSeconds : undefined
}

/** Whether a checkpoint the light client can start from is at hand, answered from the choice already made: a gateway address asks on every navigation, and the file is read again only when no chosen checkpoint is usable. */
function lightClientCanStart (): boolean {
  if (lightClientSwitchedOff()) return false
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (checkpoint?.ok === true && nowSeconds - checkpoint.checkpoint.timestamp <= MAX_CHECKPOINT_AGE_SECONDS) return true
  return chooseNow().ok
}

/**
 * Where a protocol origin's content came from and whether DDOC holds, as a tab
 * showing that origin sees it; null when it is not mounted there or the host
 * is down.
 */
export async function siteProvenance (origin: string): Promise<SiteProvenance | null> {
  if (supervisor === undefined) return null
  try {
    return await supervisor.request({ kind: 'provenance', host: new URL(origin).hostname, partition: origin, ...routeOf(origin) })
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
  return chooseNameEvidence(pin?.content, servedFromCache, live, unanswered, Date.now(), address, nodeEndpointNames())
}

/**
 * Where an origin's bundle is served from, for the loader: undefined for
 * any origin no protocol serves, and a throw when its name cannot be
 * verified now.
 *
 * Mounted in `partition` when given, the origin's own otherwise (the one a tab
 * opening it uses). A caller that is not that origin passes a partition of its
 * own, so what it asks never warms a name for anyone else (A256).
 */
export async function verifierContentAddress (origin: string, partition?: string): Promise<ContentAddress | undefined> {
  if (!servedByVerifier(origin)) return undefined
  startHost()
  await listeningGate.whenSettled()
  if (supervisor === undefined) throw new Error('the verifier has not started')
  return contentAddressOf(await supervisor.request({ kind: 'mount', host: new URL(origin).hostname, partition: partition ?? new URL(origin).origin, ...routeOf(origin) }, MOUNT_TIMEOUT_MS))
}

/** The content CID a `.eth` host names, proven now in `partition`; undefined when it does not resolve. Never throws. */
export async function verifierEthContentCid (host: string, partition: string): Promise<string | undefined> {
  try {
    return (await verifierContentAddress(`https://${host}`, partition))?.cid
  } catch {
    return undefined
  }
}

/** What the verifier host has read from each local node this session (`node-traffic.ts`): by the node's name, reads in flight now and bytes read in all, the bytes of earlier hosts included. */
const traffic = new Map<string, { active: number, bytes: number }>()
const trafficBefore = new Map<string, number>()

export function nodeTraffic (node: string): { readonly active: number, readonly bytes: number } {
  const now = traffic.get(node)
  return { active: now?.active ?? 0, bytes: (trafficBefore.get(node) ?? 0) + (now?.bytes ?? 0) }
}

/** The host is gone or asleep: what it counted is kept, and nothing is in flight. */
function foldTraffic (): void {
  for (const [node, counted] of traffic) trafficBefore.set(node, (trafficBefore.get(node) ?? 0) + counted.bytes)
  traffic.clear()
}

/** The verifier host's process while it runs, for the popup's memory and uptime rows. */
export function verifierProcessInfo (): ProcessInfo | undefined {
  return supervisor?.processInfo()
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
    ...(ethTestSeam() === undefined && { swarmNode: swarmNodeState() }),
    ...(ipfsFromNode(ethTestSeam()) && { ipfsNode: { state: ipfsNodeState(), lookupService: ipfsLookupServiceChoice() } }),
    endpoints: { ...DEFAULT_ENDPOINTS, swarmEndpoints: swarmEndpoints(ethTestSeam()), ...(ipfsFromNode(ethTestSeam()) && { ipfsNodeEndpoints: [ipfsNodeEndpoint()] }) }
  }, Date.now())
}

/** Called whenever what verifierView() says may have changed; returns the unsubscribe. */
export function onVerifierChange (listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Clearing browsing data: the names this install has visited are forgotten, and open tabs draw their addresses again. */
export async function forgetNameSchemes (): Promise<void> {
  await verifierStore().forgetNameSchemes()
  announceNameSchemeChange()
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
    routesOf = () => ctx.routes
    BUILTIN_ADDRESSES.learnSchemes((name) => verifierStore().nameScheme(name))
    installCertificateCheck(session.defaultSession)
    // The shared session and each session of its own a website gets: any of them can load a `.eth` page.
    forEachWebsiteSession((target, tunnelProfile) => { installPartitionStamp(target, tunnelProfile); installListeningGate(target) })
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
          foldTraffic()
          fingerprint = undefined
          hostDown = undefined
          hostAsleep = true
          lightClient = { state: 'off' }
          for (const node of NODES.values()) node.verifierIdle()
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
          foldTraffic()
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
        ipnsSequence: (key, sequence) => { verifierStore().saveIpnsSequence(key, sequence) },
        swarmFeedIndex: (feed, index) => { verifierStore().saveSwarmFeedIndex(feed, index) },
        nameScheme: (name, scheme) => {
          if (verifierStore().saveNameScheme(name, scheme)) announceNameSchemeChange()
        },
        nodeTraffic: (name, active, bytes) => { traffic.set(name, { active, bytes }) },
        nodeWanted: (name) => {
          const node = NODES.get(name)
          if (node === undefined) return
          // Asks that arrive while one is being answered share its answer, each told it: the host asks on every mount and every few seconds of reading.
          let pending = asking.get(name)
          if (pending === undefined) {
            pending = node.ensure().finally(() => { asking.delete(name) })
            asking.set(name, pending)
          }
          pending.then(() => { tellHost(name, node) }, (error: unknown) => { console.error(`[verifier] could not ask for the ${name}:`, error) })
        }
      }
    })
    supervisor = host
    idleHost = () => { host.idle() }
    /** Tells the host what a node is doing; it holds a mount that reads from the node on the answer. */
    function tellHost (name: string, node: LocalNodeSubsystem): void {
      const state = node.state()
      const notice: NodeNotice = { type: 'node', node: name, state: state.state, ...(state.state === 'off' && state.reason !== undefined && { reason: state.reason }), ...(state.state === 'failed' && { reason: state.reason }) }
      host.send(notice)
    }
    for (const [name, node] of NODES) {
      node.onChange(() => {
        tellHost(name, node)
        changed()
      })
      // The host holds the node's endpoint from its start: with the port renewed, it starts afresh (its next request forks it with the new one).
      node.onEndpointChange(() => { host.idle() })
    }
    const lifecycle = new HostLifecycle({
      start: () => { host.start() },
      idle: () => { host.idle() },
      tabShowsVerifiedOrigin: () => tabsOnVerifiedOrigin(),
      checkpointAgeSeconds: usableCheckpointAge,
      startDelayMs: verifierStartDelayMs,
      privateSession: ctx.privateSession
    })
    startHost = () => { lifecycle.request() }
    provideVerifierAccess({
      start: () => { startHost() },
      ready: async () => { await listeningGate.whenSettled() },
      servesName: (name) => isDevEthName(name) || ethTestSeam()?.fixtures[name] !== undefined || lightClientCanStart()
    })
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
