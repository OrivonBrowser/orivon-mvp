import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import shippedCheckpoint from '../mainnet-checkpoint.json'
import { MAINNET_GENESIS_SECONDS, SECONDS_PER_SLOT } from '../checkpoint.js'
import { loadSubsystemGraphOnce } from './subsystem-graph.test-helpers.js'

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
const registered = vi.hoisted(() => ({ beforeRequest: [] as Array<(details: unknown, current: unknown) => Promise<unknown>> }))

vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
    prependListener: vi.fn(),
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
    onBeforeSendHeaders: () => ({ remove }),
    onBeforeRequest: (_order: number, _filter: unknown, _matches: unknown, run: (details: unknown, current: unknown) => Promise<unknown>) => { registered.beforeRequest.push(run); return { remove } },
    onCompleted: () => ({ remove }),
    onHeadersReceived: () => ({ remove }),
    onResponseStarted: () => ({ remove }),
    onErrorOccurred: () => ({ remove })
  })
}))

/** What the beacon servers answer: by exact URL, or by origin for the finalized header. Any other URL under a served origin is a 404; an origin with no answer is unreachable. */
const beacon = vi.hoisted(() => ({ asked: [] as string[], answers: new Map<string, unknown>(), origins: new Set<string>() }))

vi.mock('../checkpoint-fetch-net.js', () => ({
  beaconJson: async (url: string) => {
    beacon.asked.push(url)
    const { origin, pathname } = new URL(url)
    const answer = beacon.answers.get(url) ?? (pathname === '/eth/v1/beacon/headers/finalized' ? beacon.answers.get(origin) : undefined)
    if (answer !== undefined) return answer
    if (beacon.origins.has(origin) || beacon.answers.has(origin)) throw new (await import('../checkpoint-fetch.js')).NotFoundAnswer('404')
    throw new Error('unreachable')
  }
}))

vi.mock('../../dev/eth-resolver.js', () => ({
  devEthNames: () => ({ names: [], rules: '', secureOrigins: '' }),
  isDevEthName: () => false
}))

await loadSubsystemGraphOnce()

const forks = (): FakeProcess[] => electron.forks as FakeProcess[]

async function launch (now = SHIPPED_AT_MS + DAY_MS) {
  vi.resetModules()
  vi.setSystemTime(now)
  const subsystem = await import('../verifier-subsystem.js')
  const access = await import('../verifier-access.js')
  await subsystem.verifierSubsystem.afterReady?.({} as never)
  subsystem.configureVerifier({ lightClientEnabled: () => true, windows: () => [], servedFromCache: () => false })
  const gate = registered.beforeRequest[0]
  if (gate === undefined) throw new Error('the listening gate was not registered')
  return { ...subsystem, access, gate, request: async () => await gate({ url: 'https://vitalik.eth/' }, {}) }
}

describe('the verifier subsystem', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    electron.forks.length = 0
    electron.userData = mkdtempSync(join(tmpdir(), 'orivon-verifier-test-'))
    registered.beforeRequest.length = 0
    remove.mockClear()
    delete process.env['ORIVON_ETH_LIGHT_CLIENT']
    delete process.env['ORIVON_TEST_ETH_FIXTURES']
    beacon.asked.length = 0
    beacon.answers.clear()
    beacon.origins.clear()
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  describe('renewing a checkpoint that has aged out', () => {
    const SERVERS = ['https://ethereum-beacon-api.publicnode.com', 'https://lodestar-mainnet.chainsafe.io']
    const ROOT = `0x${'c'.repeat(64)}`
    type Start = { type: string, config?: { lightClient?: { checkpoint: string }, lightClientOff?: string } }
    const starts = (index: number): Start[] => (forks()[index]?.sent as Start[]).filter((message) => message.type === 'start')

    /** The first slot of the epoch a given time before `now`: the block the servers vouch for and bootstrap from. */
    function epochStart (now: number, ageSeconds: number): number {
      const slot = Math.floor((Math.floor(now / 1000) - ageSeconds - MAINNET_GENESIS_SECONDS) / SECONDS_PER_SLOT)
      return slot - slot % 32
    }
    /** The finalized header the servers give for the epoch's first slot a given time before `now`. */
    function finalizedHeader (root: string, now: number, ageSeconds: number): unknown {
      return { execution_optimistic: false, finalized: true, data: { root, canonical: true, header: { message: { slot: String(epochStart(now, ageSeconds)) } } } }
    }
    /** Both servers vouch for `root` as the epoch's first block, and the first, the consensus server, serves its bootstrap. */
    function serve (root: string, now: number, ageSeconds: number): void {
      const slot = epochStart(now, ageSeconds)
      for (const server of SERVERS) {
        beacon.origins.add(server)
        beacon.answers.set(server, finalizedHeader(root, now, ageSeconds))
        beacon.answers.set(`${server}/eth/v1/beacon/blocks/${String(slot)}/root`, { data: { root } })
      }
      beacon.answers.set(`${SERVERS[0]!}/eth/v1/beacon/light_client/bootstrap/${root}`, { data: { header: { beacon: { slot: String(slot) } } } })
    }
    const BOOTSTRAP_404 = 'could not fetch bootstrap: rpc error on method: bootstrap, message: status: 404, message: NOT_FOUND: Sync committee branch for block root not found'
    const OLD_RELEASE = SHIPPED_AT_MS + 30 * DAY_MS

    it('fetches from two servers and starts the light client from the checkpoint they agree on, which it keeps and says so', async () => {
      serve(ROOT, OLD_RELEASE, 3600)
      const { request, verifierView } = await launch(OLD_RELEASE)
      void request()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
      expect(beacon.asked.filter((url) => url.endsWith('/headers/finalized')).sort()).toEqual(SERVERS.map((server) => `${server}/eth/v1/beacon/headers/finalized`).sort())
      expect(beacon.asked.filter((url) => url.includes('/bootstrap/'))).toEqual([`${SERVERS[0]!}/eth/v1/beacon/light_client/bootstrap/${ROOT}`])
      expect(starts(0)[0]?.config?.lightClient?.checkpoint).toBe(ROOT)
      expect(verifierView().checkpoint).toMatch(/^Checkpoint 1 hours? old, dated .* UTC\. It was fetched while a \.eth name was opened.*ethereum-beacon-api\.publicnode\.com and lodestar-mainnet\.chainsafe\.io gave the same answer\.$/)
      const stored = JSON.parse(readFileSync(join(electron.userData, 'verifier', 'checkpoint.json'), 'utf8')) as { root: string, fetchedFrom: string[] }
      expect(stored).toMatchObject({ root: ROOT, fetchedFrom: SERVERS })
    })

    it('asks nobody while the release\'s checkpoint is within the limit', async () => {
      const { request } = await launch(SHIPPED_AT_MS + DAY_MS)
      void request()
      await vi.advanceTimersByTimeAsync(0)
      expect(beacon.asked).toEqual([])
    })

    it('starts the host without a light client when the servers disagree, and says why where the checkpoint is shown', async () => {
      beacon.answers.set(SERVERS[0]!, finalizedHeader(ROOT, OLD_RELEASE, 3600))
      beacon.answers.set(SERVERS[1]!, finalizedHeader(`0x${'d'.repeat(64)}`, OLD_RELEASE, 3600))
      const { request, verifierView } = await launch(OLD_RELEASE)
      void request()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
      expect(starts(0)[0]?.config?.lightClientOff).toMatch(/cannot start: the newest checkpoint \(shipped with this release\) is 30 days old.*did not give the same answer/)
      expect(verifierView().checkpoint).toMatch(/A fresh one could not be fetched from the beacon servers: the beacon servers did not give the same answer/)
      expect(verifierView().summary).toMatch(/A fresh one could not be fetched/)
    })

    it('does not ask again within the wait, then puts the running host to sleep and asks once more', async () => {
      const { request } = await launch(OLD_RELEASE)
      void request()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
      forks()[0]?.listens()
      expect(beacon.asked).toHaveLength(2)
      void request()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(2 * MIN)
      void request()
      await vi.advanceTimersByTimeAsync(0)
      expect(beacon.asked).toHaveLength(2)
      expect(forks()[0]?.killed).toBe(false)
      serve(ROOT, Date.now() + 4 * MIN, 3600)
      await vi.advanceTimersByTimeAsync(4 * MIN)
      void request()
      await vi.advanceTimersByTimeAsync(0)
      forks()[0]?.emit('exit', 0)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
      expect(forks()[0]?.killed).toBe(true)
      expect(beacon.asked.filter((url) => url.endsWith('/headers/finalized'))).toHaveLength(4)
      expect(starts(1)[0]?.config?.lightClient?.checkpoint).toBe(ROOT)
    })

    /** Many awaits deep: the renewal asks the servers one request after another. */
    async function settle (): Promise<void> {
      for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0)
    }

    it('renews at once, and restarts the host from the new checkpoint, when the beacon server has no bootstrap for the release\'s fresh one', async () => {
      const { request, verifierView } = await launch(SHIPPED_AT_MS + DAY_MS)
      void request()
      await settle()
      expect(starts(0)[0]?.config?.lightClient?.checkpoint).toBe(shippedCheckpoint.root)
      expect(beacon.asked).toEqual([])
      forks()[0]?.listens()
      serve(ROOT, Date.now(), 600)
      forks()[0]?.emit('message', { type: 'status', status: { state: 'failed', reason: BOOTSTRAP_404, retryAt: Date.now() + 5000, bootstrapMissing: true } })
      await settle()
      expect(beacon.asked.filter((url) => url.endsWith('/headers/finalized'))).toHaveLength(2)
      forks()[0]?.emit('exit', 0)
      await settle()
      expect(forks()[0]?.killed).toBe(true)
      expect(forks()).toHaveLength(2)
      expect(starts(1)[0]?.config?.lightClient?.checkpoint).toBe(ROOT)
      expect(verifierView().checkpoint).toMatch(/It was fetched while a \.eth name was opened/)
      const stored = JSON.parse(readFileSync(join(electron.userData, 'verifier', 'checkpoint.json'), 'utf8')) as { root: string }
      expect(stored.root).toBe(ROOT)
    })

    it('treats a failed bootstrap that is not a 404 as the light client\'s own retry, and renews nothing', async () => {
      const { request } = await launch(SHIPPED_AT_MS + DAY_MS)
      void request()
      await settle()
      forks()[0]?.listens()
      for (const reason of ['could not fetch bootstrap: rpc error on method: bootstrap, message: error sending request', 'invalid timestamp']) {
        forks()[0]?.emit('message', { type: 'status', status: { state: 'failed', reason, retryAt: Date.now() + 5000 } })
        await settle()
      }
      expect(beacon.asked).toEqual([])
      expect(forks()).toHaveLength(1)
    })

    it('asks once for a root whose bootstrap keeps failing, and not again within the wait after a failed renewal', async () => {
      const { request, verifierView } = await launch(SHIPPED_AT_MS + DAY_MS)
      void request()
      await settle()
      forks()[0]?.listens()
      for (let i = 0; i < 3; i++) {
        forks()[0]?.emit('message', { type: 'status', status: { state: 'failed', reason: BOOTSTRAP_404, retryAt: Date.now() + 5000, bootstrapMissing: true } })
        await settle()
      }
      expect(beacon.asked).toHaveLength(2)
      expect(forks()).toHaveLength(1)
      expect(verifierView().checkpoint).toMatch(/^No usable checkpoint: the beacon server would not start the light client from the newest checkpoint \(shipped with this release\)\. A fresh one could not be fetched from the beacon servers: a beacon server did not answer/)
    })

    it('does not restart the host on every .eth request when the servers only name roots already given up', async () => {
      const { request } = await launch(SHIPPED_AT_MS + DAY_MS)
      void request()
      await settle()
      forks()[0]?.listens()
      serve(shippedCheckpoint.root, Date.now(), 600)
      forks()[0]?.emit('message', { type: 'status', status: { state: 'failed', reason: BOOTSTRAP_404, retryAt: Date.now() + 5000, bootstrapMissing: true } })
      await settle()
      const asked = beacon.asked.length
      expect(asked).toBeGreaterThan(0)
      for (let i = 0; i < 4; i++) {
        void request()
        await settle()
      }
      expect(beacon.asked).toHaveLength(asked)
      expect(forks()).toHaveLength(1)
      expect(forks()[0]?.killed).toBe(false)
    })

    it('replaces a stored checkpoint that has no bootstrap, even by one that is not newer', async () => {
      const stored = { root: `0x${'d'.repeat(64)}`, timestamp: Math.floor((SHIPPED_AT_MS + DAY_MS) / 1000) - 7200 }
      mkdirSync(join(electron.userData, 'verifier'), { recursive: true })
      writeFileSync(join(electron.userData, 'verifier', 'checkpoint.json'), JSON.stringify(stored))
      const { request } = await launch(SHIPPED_AT_MS + DAY_MS)
      void request()
      await settle()
      expect(starts(0)[0]?.config?.lightClient?.checkpoint).toBe(stored.root)
      forks()[0]?.listens()
      const failure = { type: 'status', status: { state: 'failed', reason: BOOTSTRAP_404, retryAt: Date.now() + 5000, bootstrapMissing: true } }
      forks()[0]?.emit('message', failure)
      await settle()
      forks()[0]?.emit('exit', 0)
      await settle()
      expect(starts(1)[0]?.config?.lightClient?.checkpoint).toBe(shippedCheckpoint.root)
      serve(ROOT, Date.now(), 7300)
      forks()[1]?.listens()
      forks()[1]?.emit('message', failure)
      await settle()
      forks()[1]?.emit('exit', 0)
      await settle()
      expect(starts(2)[0]?.config?.lightClient?.checkpoint).toBe(ROOT)
      const kept = JSON.parse(readFileSync(join(electron.userData, 'verifier', 'checkpoint.json'), 'utf8')) as { root: string }
      expect(kept.root).toBe(ROOT)
    })

    it('restarts from another usable checkpoint at hand, without asking the servers, when the one in use has no bootstrap', async () => {
      const { request } = await launch(SHIPPED_AT_MS + DAY_MS)
      void request()
      await settle()
      forks()[0]?.listens()
      forks()[0]?.emit('message', { type: 'checkpoint', root: ROOT, timestamp: Math.floor(Date.now() / 1000) - 3600 })
      forks()[0]?.emit('message', { type: 'status', status: { state: 'failed', reason: BOOTSTRAP_404, retryAt: Date.now() + 5000, bootstrapMissing: true } })
      await settle()
      forks()[0]?.emit('exit', 0)
      await settle()
      expect(starts(1)[0]?.config?.lightClient?.checkpoint).toBe(ROOT)
    })
  })
})
