import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDLE_STOP_MS, REFRESH_DELAY_MS, REFRESH_WHEN_OLDER_THAN_SECONDS } from '../host-lifecycle.js'
import shippedCheckpoint from '../mainnet-checkpoint.json'
import { MAINNET_GENESIS_SECONDS, MAX_CHECKPOINT_AGE_SECONDS, SECONDS_PER_SLOT } from '../checkpoint.js'

const SHIPPED_AT_MS = (MAINNET_GENESIS_SECONDS + shippedCheckpoint.slot * SECONDS_PER_SLOT) * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const MIN = 60_000

class FakeProcess extends EventEmitter {
  readonly sent: unknown[] = []
  killed = false
  postMessage (message: unknown): void { this.sent.push(message) }
  kill (): boolean { this.killed = true; return true }
  listens (): void { this.emit('message', { type: 'listening', fingerprint: 'sha256/run=' }) }
}

const electron = vi.hoisted(() => ({ forks: [] as unknown[], userData: '' }))
const remove = vi.hoisted(() => vi.fn())
const devNames = vi.hoisted(() => ({ names: [] as string[] }))
const registered = vi.hoisted(() => ({ beforeRequest: [] as Array<(details: unknown, current: unknown) => Promise<unknown>>, beforeSendHeaders: 0, stamps: [] as Array<(details: unknown, current: { requestHeaders: Record<string, string> }) => { requestHeaders: Record<string, string> }> }))

vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
    getPath: () => electron.userData,
    resolveProxy: async () => 'DIRECT',
    commandLine: { getSwitchValue: () => '', appendSwitch: vi.fn() }
  },
  session: { defaultSession: { setCertificateVerifyProc: vi.fn() } },
  utilityProcess: { fork: () => { const host = new FakeProcess(); electron.forks.push(host); return host } }
}))

vi.mock('../../sessions/web-request-owner.js', () => ({
  RUN_LAST: Number.MAX_SAFE_INTEGER,
  webRequestOwnerFor: () => ({
    onBeforeSendHeaders: (_order: number, _filter: unknown, _matches: unknown, run: (typeof registered.stamps)[number]) => { registered.beforeSendHeaders += 1; registered.stamps.push(run); return { remove } },
    onBeforeRequest: (_order: number, _filter: unknown, _matches: unknown, run: (details: unknown, current: unknown) => Promise<unknown>) => { registered.beforeRequest.push(run); return { remove } },
    onCompleted: () => ({ remove })
  })
}))

vi.mock('../../dev/eth-resolver.js', () => ({
  devEthNames: () => ({ names: devNames.names, rules: '', secureOrigins: '' }),
  isDevEthName: (host: string) => devNames.names.includes(host)
}))

const forks = (): FakeProcess[] => electron.forks as FakeProcess[]

async function launch (now = SHIPPED_AT_MS + DAY_MS) {
  vi.resetModules()
  vi.setSystemTime(now)
  const subsystem = await import('../verifier-subsystem.js')
  const access = await import('../verifier-access.js')
  await subsystem.verifierSubsystem.afterReady?.({} as never)
  subsystem.configureVerifier({ lightClientEnabled: () => true, windows: () => tabs.open, servedFromCache: () => false })
  const gate = registered.beforeRequest[0]
  if (gate === undefined) throw new Error('the listening gate was not registered')
  return { ...subsystem, access, gate, request: async () => await gate({ url: 'https://vitalik.eth/' }, {}) }
}

const tabs = { open: [] as Array<{ tabs: { ids: () => string[], liveWebContents: () => { getURL: () => string } }, window: { isDestroyed: () => boolean } }> }
const tabOn = (url: string): void => {
  tabs.open = [{ tabs: { ids: () => ['t'], liveWebContents: () => ({ getURL: () => url }) }, window: { isDestroyed: () => false } }]
}

describe('the verifier subsystem', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    electron.forks.length = 0
    electron.userData = mkdtempSync(join(tmpdir(), 'orivon-verifier-test-'))
    registered.beforeRequest.length = 0
    registered.beforeSendHeaders = 0
    registered.stamps.length = 0
    remove.mockClear()
    tabs.open = []
    delete process.env['ORIVON_ETH_LIGHT_CLIENT']
    delete process.env['ORIVON_TEST_ETH_FIXTURES']
    devNames.names = []
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('starts no host at launch when the checkpoint is fresh, however long nothing needs it', async () => {
    await launch()
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(forks()).toHaveLength(0)
  })

  it('starts the host once, two minutes after launch, when the newest checkpoint is 8 days old, and lets it sleep ten minutes later', async () => {
    await launch(SHIPPED_AT_MS + 8 * DAY_MS)
    await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS - 1000)
    expect(forks()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(forks()).toHaveLength(1)
    forks()[0]?.listens()
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS + 2 * MIN)
    expect(forks()[0]?.killed).toBe(true)
  })

  it('does nothing at launch when the light client is switched off, whatever the checkpoint says', async () => {
    process.env['ORIVON_ETH_LIGHT_CLIENT'] = 'off'
    await launch(SHIPPED_AT_MS + (REFRESH_WHEN_OLDER_THAN_SECONDS * 1000) + DAY_MS)
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(forks()).toHaveLength(0)
  })

  it('starts the host on the first request to a verifier-served host, and holds that request until it listens', async () => {
    const { request } = await launch()
    let done = false
    void request().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(forks()).toHaveLength(1)
    expect(done).toBe(false)
    forks()[0]?.listens()
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
  })

  describe('where IPFS is read from', () => {
    type StartMessage = { type: string, config?: { ipfsNode?: { endpoint: string, partitionSalt: string, lookupService: boolean }, gateways: string[] } }
    const started = (index: number): StartMessage | undefined => (forks()[index]?.sent as StartMessage[]).find((message) => message.type === 'start')

    async function launchWith (source: () => 'node' | 'gateways') {
      const launched = await launch()
      launched.configureVerifier({ lightClientEnabled: () => true, windows: () => tabs.open, servedFromCache: () => false, ipfsSource: source, ipfsLookupService: () => true })
      return launched
    }

    it('gives the host the node\'s loopback endpoint, and keeps the gateways for the node that cannot run, when the person reads IPFS from the node', async () => {
      const { request } = await launchWith(() => 'node')
      void request()
      await vi.advanceTimersByTimeAsync(0)
      const config = started(0)?.config
      expect(config?.ipfsNode?.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(config?.gateways.length).toBeGreaterThan(0)
    })

    it('gives the host no node, and the gateways as before, when the person chose gateways', async () => {
      const { request } = await launchWith(() => 'gateways')
      void request()
      await vi.advanceTimersByTimeAsync(0)
      expect(started(0)?.config).not.toHaveProperty('ipfsNode')
      expect(started(0)?.config?.gateways.length).toBeGreaterThan(0)
    })

    it('puts the host to sleep when the choice changes, and its next start follows the new choice', async () => {
      let source: 'node' | 'gateways' = 'node'
      const { request, ipfsSettingsChanged } = await launchWith(() => source)
      void request()
      await vi.advanceTimersByTimeAsync(0)
      forks()[0]?.listens()
      expect(started(0)?.config).toHaveProperty('ipfsNode')
      source = 'gateways'
      ipfsSettingsChanged('source')
      expect(forks()[0]?.killed).toBe(true)
      forks()[0]?.emit('exit', 0)
      void request()
      await vi.advanceTimersByTimeAsync(0)
      expect(forks()).toHaveLength(2)
      expect(started(1)?.config).not.toHaveProperty('ipfsNode')
    })

    it('stops only the IPFS node when the lookup service changes, tells the running host, and leaves it and the light client running', async () => {
      let allowed = true
      const launched = await launchWith(() => 'node')
      launched.configureVerifier({ lightClientEnabled: () => true, windows: () => tabs.open, servedFromCache: () => false, ipfsSource: () => 'node', ipfsLookupService: () => allowed })
      void launched.request()
      await vi.advanceTimersByTimeAsync(0)
      forks()[0]?.listens()
      expect(started(0)?.config?.ipfsNode?.lookupService).toBe(true)
      allowed = false
      launched.ipfsSettingsChanged('lookupService')
      expect(forks()[0]?.killed).toBe(false)
      expect(forks()).toHaveLength(1)
      expect(forks()[0]?.sent.at(-1)).toEqual({ type: 'ipfs-lookup', allowed: false })
    })

    it('hands the host a per-profile salt for the node\'s partition keys, the same at every start', async () => {
      const { request, ipfsSettingsChanged } = await launchWith(() => 'node')
      void request()
      await vi.advanceTimersByTimeAsync(0)
      forks()[0]?.listens()
      const salt = started(0)?.config?.ipfsNode?.partitionSalt
      expect(salt).toMatch(/^[0-9a-f]{64}$/)
      ipfsSettingsChanged('source')
      forks()[0]?.emit('exit', 0)
      void request()
      await vi.advanceTimersByTimeAsync(0)
      expect(started(1)?.config?.ipfsNode?.partitionSalt).toBe(salt)
    })

    it('replaces the salt and puts the host to sleep when the node\'s data is forgotten, so the next start keys its reads anew', async () => {
      const { request, forgetIpfsNodeData } = await launchWith(() => 'node')
      void request()
      await vi.advanceTimersByTimeAsync(0)
      forks()[0]?.listens()
      const salt = started(0)?.config?.ipfsNode?.partitionSalt
      await forgetIpfsNodeData()
      expect(forks()[0]?.killed).toBe(true)
      forks()[0]?.emit('exit', 0)
      void request()
      await vi.advanceTimersByTimeAsync(0)
      const next = started(1)?.config?.ipfsNode?.partitionSalt
      expect(next).toMatch(/^[0-9a-f]{64}$/)
      expect(next).not.toBe(salt)
    })

    it('never forks the IPFS node for a host that asks for it while IPFS is read from public gateways, and says where to switch it on', async () => {
      let source: 'node' | 'gateways' = 'gateways'
      const { request } = await launchWith(() => source)
      const { ipfsNodeState } = await import('../ipfs-node-subsystem.js')
      void request()
      await vi.advanceTimersByTimeAsync(0)
      forks()[0]?.listens()
      forks()[0]?.emit('message', { type: 'node-wanted', node: 'ipfs-node' })
      await vi.advanceTimersByTimeAsync(0)
      expect(forks()).toHaveLength(1)
      expect(ipfsNodeState()).toMatchObject({ state: 'off', reason: expect.stringMatching(/public gateways.*Settings under Web3/) })
      source = 'node'
    })

    it('lets the node run again, with the refusal forgotten, once the person reads IPFS from it', async () => {
      let source: 'node' | 'gateways' = 'gateways'
      const { request, ipfsSettingsChanged } = await launchWith(() => source)
      const { ipfsNodeState } = await import('../ipfs-node-subsystem.js')
      void request()
      await vi.advanceTimersByTimeAsync(0)
      forks()[0]?.listens()
      forks()[0]?.emit('message', { type: 'node-wanted', node: 'ipfs-node' })
      await vi.advanceTimersByTimeAsync(0)
      source = 'node'
      ipfsSettingsChanged('source')
      expect(ipfsNodeState()).toEqual({ state: 'off' })
    })

    it('says in the view what the node is doing while IPFS is read from it, and nothing when it is not', async () => {
      let source: 'node' | 'gateways' = 'node'
      const { verifierView } = await launchWith(() => source)
      expect(verifierView().ipfsNode?.state).toBe('off')
      expect(verifierView().endpoints.map((group) => group.label)).toContain('IPFS node, on this computer')
      source = 'gateways'
      expect(verifierView().ipfsNode).toBeUndefined()
      expect(verifierView().endpoints.map((group) => group.label)).toContain('IPFS gateways')
    })
  })

  it('serves a .eth name while the light client can start', async () => {
    const { access } = await launch()
    expect(access.verifierServesName('vitalik.eth')).toBe(true)
  })

  it('stops serving a .eth name once the chosen checkpoint is older than a checkpoint may be, without a restart', async () => {
    const { access } = await launch()
    expect(access.verifierServesName('vitalik.eth')).toBe(true)
    vi.setSystemTime(Date.now() + MAX_CHECKPOINT_AGE_SECONDS * 1000)
    expect(access.verifierServesName('vitalik.eth')).toBe(false)
  })

  it('serves no .eth name through the light client when the environment or the person switches it off', async () => {
    process.env['ORIVON_ETH_LIGHT_CLIENT'] = 'off'
    const { access } = await launch()
    expect(access.verifierServesName('vitalik.eth')).toBe(false)
    delete process.env['ORIVON_ETH_LIGHT_CLIENT']
    const person = await launch()
    person.configureVerifier({ lightClientEnabled: () => false, windows: () => [], servedFromCache: () => false })
    expect(person.access.verifierServesName('vitalik.eth')).toBe(false)
  })

  it('serves a developer-mode name and a test-build fixture name with the light client off', async () => {
    process.env['ORIVON_ETH_LIGHT_CLIENT'] = 'off'
    process.env['ORIVON_TEST_ETH_FIXTURES'] = JSON.stringify({ 'site.eth': 'ipfs://bafy' })
    vi.stubGlobal('__ORIVON_DEV_GRANT_ENABLED__', true)
    devNames.names = ['dev.eth']
    const { access } = await launch()
    expect(access.verifierServesName('dev.eth')).toBe(true)
    expect(access.verifierServesName('site.eth')).toBe(true)
    expect(access.verifierServesName('vitalik.eth')).toBe(false)
  })

  it('starts the host when an address bar input names a .eth host, and not for other text', async () => {
    const { access } = await launch()
    access.prewarmVerifier('example.com')
    access.prewarmVerifier('weather in rome')
    expect(forks()).toHaveLength(0)
    access.prewarmVerifier('vitalik.eth')
    expect(forks()).toHaveLength(1)
  })

  it('puts the host to sleep after ten minutes with no .eth tab and no request, and starts a fresh one for the next request', async () => {
    const { request } = await launch()
    void request()
    await vi.advanceTimersByTimeAsync(0)
    forks()[0]?.listens()
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS + 2 * MIN)
    const first = forks()[0]
    expect(first?.killed).toBe(true)
    first?.emit('exit', 0)
    let done = false
    void request().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(forks()).toHaveLength(2)
    expect(done).toBe(false)
    forks()[1]?.listens()
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
  })

  it('keeps the host while a tab shows a .eth page', async () => {
    const { request } = await launch()
    tabOn('https://vitalik.eth/')
    void request()
    await vi.advanceTimersByTimeAsync(0)
    forks()[0]?.listens()
    await vi.advanceTimersByTimeAsync(3 * 60 * MIN)
    expect(forks()[0]?.killed).toBe(false)
  })

  it('does not report an idle host as down, and does not restart it after it exits', async () => {
    const { request, verifierView } = await launch()
    void request()
    await vi.advanceTimersByTimeAsync(0)
    forks()[0]?.listens()
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS + 2 * MIN)
    forks()[0]?.emit('exit', 0)
    await vi.advanceTimersByTimeAsync(5 * 60 * MIN)
    expect(forks()).toHaveLength(1)
    const view = verifierView()
    expect(view.state).toBe('waiting')
    expect(view.summary).toMatch(/^On, and waiting/)
  })

  it('follows the light client switch at once: the view says off, and the host\'s next start is told it is off', async () => {
    vi.resetModules()
    vi.setSystemTime(SHIPPED_AT_MS + DAY_MS)
    const subsystem = await import('../verifier-subsystem.js')
    await subsystem.verifierSubsystem.afterReady?.({} as never)
    let enabled = true
    subsystem.configureVerifier({ lightClientEnabled: () => enabled, windows: () => tabs.open, servedFromCache: () => false })
    expect(subsystem.verifierView()).toMatchObject({ state: 'waiting' })
    enabled = false
    expect(subsystem.verifierView()).toMatchObject({ state: 'off', summary: expect.stringMatching(/^Switched off/) })
  })

  it('puts the host to sleep when the light client is switched, so its next start builds its config from the new choice', async () => {
    vi.resetModules()
    vi.setSystemTime(SHIPPED_AT_MS + DAY_MS)
    const subsystem = await import('../verifier-subsystem.js')
    await subsystem.verifierSubsystem.afterReady?.({} as never)
    const started = (index: number): { config?: { lightClient?: unknown, lightClientOff?: string } } | undefined => (forks()[index]?.sent as Array<{ type: string, config?: { lightClient?: unknown, lightClientOff?: string } }>).find((message) => message.type === 'start')
    let enabled = true
    subsystem.configureVerifier({ lightClientEnabled: () => enabled, windows: () => tabs.open, servedFromCache: () => false })
    void subsystem.verifierContentAddress('https://vitalik.eth').catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    forks()[0]?.listens()
    expect(started(0)?.config?.lightClient).toBeDefined()
    enabled = false
    subsystem.lightClientSettingChanged()
    expect(forks()[0]?.killed).toBe(true)
    forks()[0]?.emit('exit', 0)
    void subsystem.verifierContentAddress('https://vitalik.eth').catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(forks()).toHaveLength(2)
    expect(started(1)?.config?.lightClient).toBeUndefined()
    expect(started(1)?.config?.lightClientOff).toMatch(/switched off/)
  })

  it('puts the host to sleep when the Swarm node is switched, so what it mounted from Swarm and its Swarm config do not outlive the switch', async () => {
    vi.resetModules()
    vi.setSystemTime(SHIPPED_AT_MS + DAY_MS)
    const subsystem = await import('../verifier-subsystem.js')
    await subsystem.verifierSubsystem.afterReady?.({} as never)
    let swarmOn = true
    subsystem.configureVerifier({ lightClientEnabled: () => true, windows: () => tabs.open, servedFromCache: () => false, swarmNodeEnabled: () => swarmOn })
    void subsystem.verifierContentAddress('https://vitalik.eth').catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    forks()[0]?.listens()
    swarmOn = false
    subsystem.swarmSettingChanged()
    expect(forks()[0]?.killed).toBe(true)
  })

  it('keeps what the host counted of the nodes it knows and forgets any other name, which a hostile host could send for ever', async () => {
    const { request, nodeTraffic } = await launch()
    void request()
    await vi.advanceTimersByTimeAsync(0)
    forks()[0]?.listens()
    forks()[0]?.emit('message', { type: 'node-traffic', node: 'ipfs-node', active: 2, bytes: 500 })
    forks()[0]?.emit('message', { type: 'node-traffic', node: 'made-up-node', active: 9, bytes: 9_000 })
    expect(nodeTraffic('ipfs-node')).toEqual({ active: 2, bytes: 500 })
    expect(nodeTraffic('made-up-node')).toEqual({ active: 0, bytes: 0 })
    forks()[0]?.emit('exit', 1)
    expect(nodeTraffic('ipfs-node')).toEqual({ active: 0, bytes: 500 })
  })

  it('does not count a report twice that a host sends after it failed and before it exited, and counts the next host', async () => {
    const { request, nodeTraffic } = await launch()
    void request()
    await vi.advanceTimersByTimeAsync(0)
    forks()[0]?.listens()
    forks()[0]?.emit('message', { type: 'node-traffic', node: 'ipfs-node', active: 2, bytes: 500 })
    forks()[0]?.emit('message', { type: 'failed', stage: 'listen', message: 'port taken' })
    forks()[0]?.emit('message', { type: 'node-traffic', node: 'ipfs-node', active: 2, bytes: 600 })
    forks()[0]?.emit('exit', 1)
    expect(nodeTraffic('ipfs-node')).toEqual({ active: 0, bytes: 500 })
    await vi.advanceTimersByTimeAsync(60_000)
    forks()[1]?.listens()
    forks()[1]?.emit('message', { type: 'node-traffic', node: 'ipfs-node', active: 1, bytes: 40 })
    expect(nodeTraffic('ipfs-node')).toEqual({ active: 1, bytes: 540 })
  })

  it('says the light client is on and waiting before any .eth address was opened', async () => {
    const { verifierView } = await launch()
    expect(verifierView()).toMatchObject({ state: 'waiting', summary: expect.stringMatching(/^On, and waiting/) })
  })

  it('keeps the partition stamp and the listening gate registered on the default session through start and sleep', async () => {
    const { request } = await launch()
    expect(registered.beforeSendHeaders).toBe(1)
    expect(registered.beforeRequest).toHaveLength(1)
    void request()
    await vi.advanceTimersByTimeAsync(0)
    forks()[0]?.listens()
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS + 2 * MIN)
    forks()[0]?.emit('exit', 0)
    void request()
    await vi.advanceTimersByTimeAsync(0)
    expect(registered.beforeSendHeaders).toBe(1)
    expect(registered.beforeRequest).toHaveLength(1)
    expect(remove).not.toHaveBeenCalled()
  })

  it('marks the requests of the tunnel profile\'s session as a tunnel-profile website\'s and strips the mark from every other session\'s', async () => {
    await launch()
    const { announceWebsiteSession } = await import('../../sessions/website-sessions.js')
    announceWebsiteSession({} as never, 'nym')
    announceWebsiteSession({} as never, undefined)
    announceWebsiteSession({} as never, 'socks5')
    expect(registered.stamps).toHaveLength(4)
    const stamped = registered.stamps.map((stamp) => stamp({ url: 'https://a.eth/', resourceType: 'mainFrame', frame: undefined }, { requestHeaders: { 'X-Orivon-Route': 'nym', accept: '*/*' } }).requestHeaders)
    expect(stamped.map((headers) => headers['x-orivon-route'])).toEqual([undefined, 'nym', undefined, 'socks5'])
    expect(stamped.map((headers) => Object.keys(headers).filter((name) => name.toLowerCase() === 'x-orivon-route').length)).toEqual([0, 1, 0, 1])
  })

  describe('with the tunnel profile', () => {
    const FRONT = { port: 4242, username: 'orivon', secret: 'profile-secret' }
    const frontsAsked: string[] = []
    const routes = (profile: 'nym' | 'socks5' | 'direct' | undefined, kind: 'nym' | 'socks5' = 'nym') => ({
      controller: { settled: async () => {} },
      hub: { isRouted: () => false, front: async (origin: string) => { frontsAsked.push(origin); return FRONT }, profileFor: () => profile },
      defaultKind: () => kind
    })
    type Sent = { type: string, config?: { profileFronts?: unknown }, request?: { kind: string, route?: string, partition: string } }
    const sent = (): Sent[] => forks()[0]?.sent as Sent[]

    async function launchWithRoutes (profile: 'nym' | 'socks5' | 'direct' | undefined, kind: 'nym' | 'socks5' = 'nym') {
      vi.resetModules()
      vi.setSystemTime(SHIPPED_AT_MS + DAY_MS)
      const subsystem = await import('../verifier-subsystem.js')
      await subsystem.verifierSubsystem.afterReady?.({ routes: routes(profile, kind) } as never)
      subsystem.configureVerifier({ lightClientEnabled: () => true, windows: () => tabs.open, servedFromCache: () => false })
      const gate = registered.beforeRequest[0]
      void gate?.({ url: 'https://vitalik.eth/' }, {})
      await vi.advanceTimersByTimeAsync(0)
      forks()[0]?.listens()
      await vi.advanceTimersByTimeAsync(0)
      return subsystem
    }

    it('gives the host the front of each tunnel\'s profile to fetch through for its websites, whatever the whole-browser setting is and whichever tunnel is the default', async () => {
      for (const kind of ['nym', 'socks5'] as const) {
        frontsAsked.length = 0
        forks().length = 0
        registered.beforeRequest.length = 0
        await launchWithRoutes('nym', kind)
        const front = { port: 4242, username: 'orivon', password: 'profile-secret' }
        expect(sent().find((message) => message.type === 'start')?.config?.profileFronts, kind).toEqual({ nym: front, socks5: front })
        expect(frontsAsked.sort(), kind).toEqual(['orivon-proxy-profile', 'orivon-tunnel-profile'])
      }
    })

    it('asks the host about a tunnel-profile website through the tunnel, and about any other website the ordinary way', async () => {
      const tunnelled = await launchWithRoutes('nym')
      void tunnelled.siteProvenance('https://a.eth')
      await vi.advanceTimersByTimeAsync(0)
      expect(sent().filter((message) => message.type === 'request').map((message) => message.request)).toEqual([{ kind: 'provenance', host: 'a.eth', partition: 'https://a.eth', route: 'nym' }])
      forks().length = 0
      registered.beforeRequest.length = 0
      const proxied = await launchWithRoutes('socks5')
      void proxied.siteProvenance('https://a.eth')
      await vi.advanceTimersByTimeAsync(0)
      expect(sent().filter((message) => message.type === 'request').map((message) => message.request)).toEqual([{ kind: 'provenance', host: 'a.eth', partition: 'https://a.eth', route: 'socks5' }])
      forks().length = 0
      registered.beforeRequest.length = 0
      const direct = await launchWithRoutes('direct')
      void direct.siteProvenance('https://a.eth')
      await vi.advanceTimersByTimeAsync(0)
      expect(sent().filter((message) => message.type === 'request').map((message) => message.request)).toEqual([{ kind: 'provenance', host: 'a.eth', partition: 'https://a.eth' }])
    })
  })

  it('shows a name by the scheme the host reports, tells the windows when it changes, and forgets it on request', async () => {
    const { request, forgetNameSchemes } = await launch()
    const { onNameSchemeChange } = await import('../name-scheme-events.js')
    const { BUILTIN_ADDRESSES } = await import('../../../protocols/builtin.js')
    const changed = vi.fn()
    onNameSchemeChange(changed)
    void request()
    await vi.advanceTimersByTimeAsync(0)
    forks()[0]?.listens()
    expect(BUILTIN_ADDRESSES.displayUrl('https://swarm.eth/')).toBe('https://swarm.eth/')
    forks()[0]?.emit('message', { type: 'name-scheme', host: 'swarm.eth', scheme: 'bzz' })
    expect(BUILTIN_ADDRESSES.displayUrl('https://swarm.eth/')).toBe('bzz://swarm.eth/')
    expect(changed).toHaveBeenCalledTimes(1)
    forks()[0]?.emit('message', { type: 'name-scheme', host: 'swarm.eth', scheme: 'bzz' })
    expect(changed).toHaveBeenCalledTimes(1)
    await forgetNameSchemes()
    expect(BUILTIN_ADDRESSES.displayUrl('https://swarm.eth/')).toBe('https://swarm.eth/')
    expect(changed).toHaveBeenCalledTimes(2)
  })
})
