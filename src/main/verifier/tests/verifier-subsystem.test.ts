import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDLE_STOP_MS, REFRESH_DELAY_MS, REFRESH_WHEN_OLDER_THAN_SECONDS } from '../host-lifecycle.js'
import shippedCheckpoint from '../mainnet-checkpoint.json'
import { MAINNET_GENESIS_SECONDS, SECONDS_PER_SLOT } from '../checkpoint.js'

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
const registered = vi.hoisted(() => ({ beforeRequest: [] as Array<(details: unknown, current: unknown) => Promise<unknown>>, beforeSendHeaders: 0 }))

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
    onBeforeSendHeaders: () => { registered.beforeSendHeaders += 1; return { remove } },
    onBeforeRequest: (_order: number, _filter: unknown, _matches: unknown, run: (details: unknown, current: unknown) => Promise<unknown>) => { registered.beforeRequest.push(run); return { remove } }
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

  it('serves a .eth name while the light client can start', async () => {
    const { access } = await launch()
    expect(access.verifierServesName('vitalik.eth')).toBe(true)
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

  it('keeps the light client choice it was started with when the setting changes, as Settings says it applies at the next start', async () => {
    vi.resetModules()
    vi.setSystemTime(SHIPPED_AT_MS + DAY_MS)
    const subsystem = await import('../verifier-subsystem.js')
    await subsystem.verifierSubsystem.afterReady?.({} as never)
    let enabled = true
    subsystem.configureVerifier({ lightClientEnabled: () => enabled, windows: () => tabs.open, servedFromCache: () => false })
    enabled = false
    expect(subsystem.verifierView()).toMatchObject({ state: 'waiting', summary: expect.stringMatching(/^On, and waiting/) })
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
})
