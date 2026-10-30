// Registers the verifier: the resolver rules sending every host a protocol
// serves (a `.eth` name, an `ipfs://` address) to its loopback port, the
// certificate check on every session, and the host process, started by the
// first request that needs it (or an address typed that names one) and put to
// sleep once nothing has needed it for a while. Not critical: without it
// every such load fails closed and nothing else changes.

import { join } from 'node:path'
import { app, session } from 'electron'
import type { Session, WebFrameMain, WebRequestFilter } from 'electron'
import type { Subsystem } from '../registry.js'
import { devEthNames, isDevEthName } from '../dev/eth-resolver.js'
import type { HostConfig, LightClientState, NodeNotice, SiteProvenance, TunnelRoute } from '../../protocols/verifier-host/protocol.js'
import type { ContentAddress, PinRecord } from '../../broker/policy/pin.js'
import { servedByVerifier } from '../../loader/fetch/verifier-origin.js'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { PARTITION_HEADER, ROUTE_HEADER } from '../../loader/fetch/content-root.js'
import { noteCertificate } from '../auth/note-certificate.js'
import { ACCEPT, CHROMIUM_VERDICT, REJECT, refusalNote, verifierCertificateVerdict } from './certificate-check.js'
import { installFileFailureWatch, installPartitionStamp, targetsVerifiedHost, verifiedHostFilter } from './partition-stamp.js'
import { RUN_LAST, webRequestOwnerFor } from '../sessions/web-request-owner.js'
import { forEachWebsiteSession } from '../sessions/website-sessions.js'
import { contentAddressOf } from './content-address.js'
import { CheckpointRenewal } from './checkpoint-renewal.js'
import { DEFAULT_ENDPOINTS } from './endpoints.js'
import { HostSupervisor } from './host-supervisor.js'
import { hostForker } from '../diagnostics/host-fork.js'
import { TrafficLedger } from './traffic-ledger.js'
import type { ProcessInfo } from './process-supervisor.js'
import { loopbackPort } from './loopback-port.js'
import { composeResolverRules } from './resolver-rules.js'
import { ListeningGate } from './listening-gate.js'
import { installFirstContact, noteAcceptedConnection, resetFirstContacts } from './first-contact-sessions.js'
import { announceNameSchemeChange } from './name-scheme-events.js'
import { ethTestSeam, exposeVerifierStart, noteVerifierListening, verifierStartDelayMs, type EthTestSeam } from './test-seam.js'
import { VerifierStore } from './verifier-store.js'
import { chooseNameEvidence } from './name-evidence.js'
import { lastProvenance } from './kept-provenance.js'
import type { NameEvidence } from './name-evidence.js'
import { lightClientLog, lightClientView } from './status-view.js'
import { lightClientConfig } from './light-client-config.js'
import { EthServersSource } from './eth-servers-source.js'
import { ipfsReadFromNode, nodeEndpointNames, swarmEndpoints } from './node-endpoints.js'
import type { EthServers } from './eth-servers.js'
import type { LightClientView } from './status-view.js'
import { ccipDirectFor, tunnelFront, tunnelProfileFronts, unproxiedGatewaysFor } from './host-proxy.js'
import { HostLifecycle } from './host-lifecycle.js'
import { mountCeilingMs } from '../../protocols/verifier-host/pace.js'
import { anyTabOnVerifiedOrigin } from './tab-on-verified-origin.js'
import type { TabsOfWindow } from './tab-on-verified-origin.js'
import { provideVerifierAccess } from './verifier-access.js'
import { configureSwarmNode, swarmNode, swarmNodeState, swarmSwitchedOff } from './swarm-node-subsystem.js'
import { configureIpfsNode, ipfsNode, ipfsNodeEndpoint, ipfsNodeState } from './ipfs-node-subsystem.js'
import type { LocalNodeSubsystem } from './local-node-subsystem.js'
import { IPFS_NODE_IDENTITY } from '../../protocols/ipfs-node/protocol.js'
import { SWARM_NODE_IDENTITY } from '../../protocols/swarm-node/protocol.js'
import type { RouteService } from '../route/route-service.js'
import { configureNodeRoute, ethereumOutsideTunnel, nodesMayServeTunnelSites, nodesRunThroughTunnel } from './node-route.js'
import { forgetNodeData as forgetNodes } from './forget-node-data.js'

/** A mount may wait for the light client to sync, resolve a name and follow its pointers: the host's own bound (verifier-host/pace.ts) and this much beyond it, so the host's answer is the one that comes. */
const MOUNT_GRACE_MS = 5_000
let hostThroughTunnel = false
/** How long a request to a verifier-served host waits for the host to listen: about three times the slowest start measured (3 s), so a host that never answers still ends in the ordinary error. */
const LISTEN_WAIT_MS = 10_000

let fingerprint: string | undefined
let supervisor: HostSupervisor | undefined
let store: VerifierStore | undefined
let lightClient: LightClientState = { state: 'off' }
const logLightClient = lightClientLog()
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
/** The Ethereum servers the light client asks: Orivon's, or the person's. Read at each host start and each time a view is drawn. */
const ethServers = new EthServersSource()
/** Puts the host to sleep so that its next request rebuilds its config. Set once the host exists. */
let idleHost: () => void = () => {}
/** The routes, published after this subsystem starts: read when the host's config is built. */
let routesOf: () => RouteService | undefined = () => undefined

/**
 * The browser-wide tunnel setting changed: the host's direct routes and its fetch are decided when it starts (whether a proxy
 * applies is read once, and the front it signs in to is part of its config), so it sleeps and its next request rebuilds them.
 * The local nodes stop with it. Also called when "Use tunnel to run network nodes" flips: they start on the other path.
 */
export function tunnelDefaultChanged (): void {
  idleHost()
  // Also when the host was not running: a node started for an earlier ask keeps dialling until it is stopped.
  for (const node of NODES.values()) node.verifierIdle()
  changed()
}

/** Lets the person's setting, and not only the environment, switch the light client off. Read each time the host builds its config and each time a view is drawn, so a change reaches the next start; `lightClientSettingChanged` makes that next start now. */
export function configureVerifier (options: { lightClientEnabled: () => boolean, windows: () => readonly TabsOfWindow[], servedFromCache: (origin: string) => boolean, ipfsSource?: () => 'node' | 'gateways', ipfsLookupService?: () => boolean, swarmNodeEnabled?: () => boolean, nodesFollowTunnel?: () => boolean, ethServers?: () => EthServers }): void {
  if (options.nodesFollowTunnel !== undefined) configureNodeRoute({ followTunnel: options.nodesFollowTunnel, nodesTunnel: () => routesOf()?.defaultKind() ?? 'nym' })
  if (options.ipfsSource !== undefined) ipfsSourceChoice = options.ipfsSource
  if (options.ipfsLookupService !== undefined) ipfsLookupServiceChoice = options.ipfsLookupService
  configureIpfsNode({ lookupService: () => ipfsLookupServiceChoice(), readFromNode: () => ipfsSourceChoice() === 'node' })
  if (options.swarmNodeEnabled !== undefined) configureSwarmNode({ enabled: options.swarmNodeEnabled })
  if (options.ethServers !== undefined) ethServers.configure(options.ethServers)
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
  // The node's controller reads its switch again: a node that must not run is stopped and says why, as the Swarm node does.
  if (setting === 'source') ipfsNode.reconsider()
  ipfsNode.verifierIdle()
  if (setting === 'source') idleHost()
  // A running host asks a name service for an IPNS record only while the lookup service is allowed.
  else supervisor?.send({ type: 'ipfs-lookup', allowed: ipfsLookupServiceChoice() })
  changed()
}

/**
 * The person switched the light client on or off: applied at once. The host builds its config when it starts, so it sleeps
 * and its next request rebuilds it with the new choice. A host that sleeps stops the IPFS and Swarm nodes with it, as it
 * does after ten idle minutes: each starts again at the next ask. A `.eth` page open now says why it cannot load until the
 * light client is on again.
 */
export function lightClientSettingChanged (): void {
  idleHost()
  changed()
}

/** The person changed which Ethereum servers are asked, or an address in their list: applied at once, when the servers asked are not the same ones. A host started with the light client off holds no servers, so it keeps running (and the nodes it carries with it). */
export function ethServersChanged (): void {
  if (!ethServers.changed()) return
  if (lightClientSwitchedOff()) changed()
  else lightClientSettingChanged()
}

/**
 * The person switched the Swarm node on or off: applied at once. The node's controller reads its switch again (a node that
 * must not run is stopped and says why), and the host sleeps, so nothing it mounted from Swarm outlives a switch-off and its
 * next start asks the node again.
 */
export function swarmSettingChanged (): void {
  swarmNode.reconsider()
  idleHost()
  changed()
}

/**
 * Clearing cached data or all history: the IPFS node stops and its block store is deleted, and the salt its partition
 * keys are made with is replaced, so nothing it kept about the sites visited can be read back or asked for. The Swarm
 * chunks the host keeps are keyed by the same salt: the host exits, and its files go (`forget-node-data.ts`).
 */
export async function forgetNodeData (): Promise<void> {
  await forgetNodes({ forgetIpfsNode: async () => { await ipfsNode.forget() }, replaceSalt: () => { verifierStore().rotatePartitionSalt() }, sleepHost: () => { idleHost() }, hostGone: async () => { await supervisor?.whenGone() }, directory: () => verifierStore().directory, currentSalt: () => verifierStore().partitionSalt() })
}

/** Whether this run was started with the light client forced off from outside (`ORIVON_ETH_LIGHT_CLIENT=off`): no setting changes that. */
export const lightClientForcedOff = (): boolean => process.env['ORIVON_ETH_LIGHT_CLIENT'] === 'off'

const lightClientSwitchedOff = (): boolean => lightClientForcedOff() || !enabledByPerson()

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
    if (verdict === ACCEPT) noteAcceptedConnection(target, request.hostname)
  })
}

/**
 * Holds a request to a verifier-served host until the host listens, so a
 * page opened in the first moments after launch loads instead of landing on
 * the connection-refused page, and then lets the first request to each host
 * connect before the others (first-contact.ts). Default session only, like the
 * stamp above: the other sessions that reach the verifier register their own handlers.
 */
function installListeningGate (target: Session): void {
  const firstContact = installFirstContact(target)
  webRequestOwnerFor(target).onBeforeRequest(0, verifiedHostFilter(), targetsVerifiedHost, async (details, current) => {
    startHost()
    await listeningGate.whenSettled()
    await firstContact(details.url, details.id)
    return current
  })
}

function verifierStore (): VerifierStore {
  store ??= new VerifierStore(join(app.getPath('userData'), 'verifier'))
  return store
}

/** The beacon server the light client bootstraps from, and whether it is on this computer or a home network. */
function consensusOf (): { readonly url: string, readonly local: boolean } {
  const { consensusRpc, localEndpoints } = ethServers.current()
  return { url: consensusRpc, local: localEndpoints.includes(consensusRpc) }
}

const renewal = new CheckpointRenewal({ store: verifierStore, switchedOff: () => lightClientSwitchedOff(), changed: () => { changed() }, hostRunning: () => !hostAsleep, restartHost: () => { idleHost(); startHost() }, consensus: consensusOf })

const ipfsFromNode = (seam: EthTestSeam | undefined): boolean => ipfsReadFromNode(seam, ipfsSourceChoice())

async function hostConfig (): Promise<HostConfig> {
  // Started before anything is awaited, so the requests waiting for the host count their time to start from its end.
  const renewing = renewal.start()
  if (renewing !== undefined) listeningGate.hold(renewing)
  const seam = ethTestSeam()
  const front = await tunnelFront(routesOf())
  hostThroughTunnel = front !== undefined
  const stored = verifierStore()
  const swarmChunks = stored.swarmChunks()
  const lightClient = await lightClientConfig({ switchedOff: lightClientSwitchedOff(), renewing, renewal, servers: ethServers.forHost() })
  const gateways = seam?.gateways ?? DEFAULT_ENDPOINTS.gateways
  return {
    port: loopbackPort(),
    ...lightClient,
    gateways,
    // Through the tunnel nothing is reached around it, whatever the proxy check answers.
    unproxiedGateways: front === undefined ? await unproxiedGatewaysFor(gateways, seam !== undefined) : [],
    ccipDirect: front === undefined && await ccipDirectFor(seam !== undefined),
    ...(front === undefined ? {} : { front }),
    profileFronts: await tunnelProfileFronts(routesOf()),
    ipnsNameServices: seam === undefined ? DEFAULT_ENDPOINTS.ipnsNameServices : [],
    dnsOverHttps: seam?.dnsOverHttps ?? DEFAULT_ENDPOINTS.dnsOverHttps,
    ipnsSequences: stored.ipnsSequences(),
    swarmEndpoints: swarmEndpoints(seam),
    ...(seam === undefined && { swarmNode: true }),
    ...(swarmSwitchedOff() && { swarmSwitchedOff: true }),
    tunnelSitesReadNodes: { nym: nodesMayServeTunnelSites('nym'), socks5: nodesMayServeTunnelSites('socks5') }, ...(nodesRunThroughTunnel() && { nodesRouted: true }), ...(await ethereumOutsideTunnel(front !== undefined) && { ethereumOutside: true }),
    ...(ipfsFromNode(seam) && { ipfsNode: { endpoint: ipfsNodeEndpoint(), partitionSalt: stored.partitionSalt(), lookupService: ipfsLookupServiceChoice(), ...(seam?.ipfsNode?.retryWaitMs !== undefined && { retryWaitMs: seam.ipfsNode.retryWaitMs }) } }),
    swarmFeedIndexes: stored.swarmFeedIndexes(),
    ...(swarmChunks !== undefined && { swarmChunks }),
    ...(seam === undefined ? {} : { fixtures: seam.fixtures })
  }
}

/** The tunnel of the profile the website at `origin` lives in, if any: its name is then proved, and its files read, only through that tunnel. */
function routeOf (origin: string): { readonly route?: TunnelRoute } {
  const profile = routesOf()?.hub.profileFor(origin) ?? 'direct'
  return profile === 'direct' ? {} : { route: profile }
}

/**
 * Where a protocol origin's content came from and whether DDOC holds, as a tab
 * showing that origin sees it; null when it is not mounted there or the host
 * is down.
 */
export async function siteProvenance (origin: string, route = routeOf(origin)): Promise<SiteProvenance | null> {
  if (supervisor === undefined) return null
  try {
    return await supervisor.request({ kind: 'provenance', host: new URL(origin).hostname, partition: origin, ...route })
  } catch {
    return null
  }
}

/** How a `.eth` name or an address led to the content this tab shows, for the site-info popover; undefined for any other origin. */
export async function verifierNameEvidence (origin: string, pin: PinRecord | null, servedFromCache: boolean): Promise<NameEvidence | undefined> {
  if (!servedByVerifier(origin)) return undefined
  const route = routeOf(origin)
  const { provenance: live, kept } = lastProvenance.resolve(`${origin} ${route.route ?? ''}`, await siteProvenance(origin, route))
  const address = BUILTIN_ADDRESSES.servedName(new URL(origin).hostname)?.namespace.endsWith(':') === true
  // An address needs no light client, so its state would explain nothing.
  const unanswered = address ? 'The verifier has not loaded it in this tab yet.' : verifierView().summary
  return chooseNameEvidence(pin?.content, servedFromCache, live, unanswered, Date.now(), address, nodeEndpointNames(), kept)
}

/**
 * Where an origin's bundle is served from, for the loader: undefined for
 * any origin no protocol serves, and a throw when its name cannot be
 * verified now.
 *
 * Mounted in `partition` when given, the origin's own otherwise (the one a tab
 * opening it uses). A caller that is not that origin passes a partition of its
 * own, so what it asks never warms a name for anyone else (A256). `latest` asks
 * the name itself, where a mounted site otherwise answers with what it holds.
 */
export async function verifierContentAddress (origin: string, partition?: string, latest = false): Promise<ContentAddress | undefined> {
  if (!servedByVerifier(origin)) return undefined
  startHost()
  await listeningGate.whenSettled()
  if (supervisor === undefined) throw new Error('the verifier has not started')
  return contentAddressOf(await supervisor.request({ kind: 'mount', host: new URL(origin).hostname, partition: partition ?? new URL(origin).origin, ...routeOf(origin), ...(latest ? { latest } : {}) }, mountCeilingMs(hostThroughTunnel || routeOf(origin).route !== undefined) + MOUNT_GRACE_MS))
}

/** The content CID a `.eth` host names, proven now in `partition`; undefined when it does not resolve. Never throws. */
export async function verifierEthContentCid (host: string, partition: string): Promise<string | undefined> {
  try {
    return (await verifierContentAddress(`https://${host}`, partition))?.cid
  } catch {
    return undefined
  }
}

/** What the verifier host has read from each local node this session (`traffic-ledger.ts`): reads in flight now, and bytes in all, those of earlier hosts included. */
const ledger = new TrafficLedger(new Set(NODES.keys()))

export function nodeTraffic (node: string): { readonly active: number, readonly bytes: number } {
  return ledger.read(node)
}

/** The verifier host's process while it runs, for the popup's memory and uptime rows. */
export function verifierProcessInfo (): ProcessInfo | undefined {
  return supervisor?.processInfo()
}

/** The light client's state in words, for the Settings section and the site-info popover. */
export function verifierView (): LightClientView {
  const fetchProblem = renewal.problem()
  const servers = ethServers.current()
  return lightClientView({
    lightClient,
    // A sleeping host reports no newer checkpoint, so the one it would start from is chosen again at the age it has now.
    checkpoint: hostAsleep ? renewal.choose() : renewal.chosen ?? renewal.choose(),
    ...(fetchProblem !== undefined && { checkpointFetchProblem: fetchProblem }),
    hostDown,
    hostAsleep: hostAsleep && hostDown === undefined,
    switchedOff: lightClientSwitchedOff(),
    ownServers: servers.own,
    ...(ethTestSeam() === undefined && { swarmNode: swarmNodeState() }),
    ...(ipfsFromNode(ethTestSeam()) && { ipfsNode: { state: ipfsNodeState(), lookupService: ipfsLookupServiceChoice() } }),
    endpoints: { ...DEFAULT_ENDPOINTS, executionRpcs: servers.executionRpcs, consensusRpc: servers.consensusRpc, checkpointBeaconApis: renewal.servers(), swarmEndpoints: swarmEndpoints(ethTestSeam()), ...(ipfsFromNode(ethTestSeam()) && { ipfsNodeEndpoints: [ipfsNodeEndpoint()] }) }
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
    forEachWebsiteSession((target, tunnel) => { installPartitionStamp(target, tunnel); installFileFailureWatch(target); installListeningGate(target) })
    const host = new HostSupervisor({
      fork: hostForker({ module: join(__dirname, 'verifier-host.js'), serviceName: 'Orivon verifier', prefix: '[verifier]', unlimited: process.env['ORIVON_VERIFIER_LOG'] === '1' }),
      config: hostConfig,
      events: {
        starting: () => {
          resetFirstContacts()
          ledger.open()
          hostAsleep = false
          listeningGate.starting()
          changed()
        },
        idle: () => {
          resetFirstContacts()
          ledger.fold()
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
          resetFirstContacts()
          hostDown = undefined
          hostAsleep = false
          noteVerifierListening(true)
          listeningGate.listening()
          changed()
        },
        down: (reason) => {
          ledger.fold()
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
          const line = logLightClient(value)
          if (line !== undefined) console[line.level](`[verifier] ${line.text}`)
          if (value.state === 'failed' && value.bootstrapMissing === true) renewal.recoverUnserved()
          changed()
        },
        checkpoint: (root, timestamp) => {
          try {
            verifierStore().saveCheckpoint({ root, timestamp }, Math.floor(Date.now() / 1000))
          } catch (error) {
            // A full or read-only profile: the checkpoint is fetched again by a later run.
            console.error('[verifier] could not keep the new checkpoint:', error)
          }
          renewal.choose()
          changed()
        },
        ipnsSequence: (key, sequence) => { verifierStore().saveIpnsSequence(key, sequence) },
        swarmFeedIndex: (feed, index) => { verifierStore().saveSwarmFeedIndex(feed, index) },
        nameScheme: (name, scheme) => {
          if (verifierStore().saveNameScheme(name, scheme)) announceNameSchemeChange()
        },
        nodeTraffic: (name, active, bytes) => { ledger.record(name, active, bytes) },
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
      checkpointAgeSeconds: () => renewal.usableAgeSeconds(),
      startDelayMs: verifierStartDelayMs,
      privateSession: ctx.privateSession
    })
    startHost = () => {
      // A running host started with no checkpoint, so without a light client: once the servers may be asked again, it sleeps and this start renews.
      if (!hostAsleep && renewal.due()) idleHost()
      lifecycle.request()
    }
    provideVerifierAccess({
      start: () => { startHost() },
      ready: async () => { await listeningGate.whenSettled() },
      servesName: (name) => isDevEthName(name) || ethTestSeam()?.fixtures[name] !== undefined || renewal.canStart()
    })
    exposeVerifierStart(() => { startHost() }, () => { host.idle() })
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
