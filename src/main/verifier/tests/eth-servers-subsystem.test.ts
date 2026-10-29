import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import shippedCheckpoint from '../mainnet-checkpoint.json'
import { MAINNET_GENESIS_SECONDS, SECONDS_PER_SLOT } from '../checkpoint.js'
import { effectiveEthServers } from '../eth-servers.js'

// The harness is verifier-subsystem.test.ts's, cut to what a host start needs.
const SHIPPED_AT_MS = (MAINNET_GENESIS_SECONDS + shippedCheckpoint.slot * SECONDS_PER_SLOT) * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const RPC = 'https://rpc.example.com'

class FakeProcess extends EventEmitter {
  readonly sent: unknown[] = []
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  options: unknown
  killed = false
  postMessage (message: unknown): void { this.sent.push(message) }
  kill (): boolean { this.killed = true; return true }
  listens (): void { this.emit('message', { type: 'listening', fingerprint: 'sha256/run=' }) }
}

const electron = vi.hoisted(() => ({ forks: [] as unknown[], userData: '' }))
const remove = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: { on: vi.fn(), prependListener: vi.fn(), getPath: () => electron.userData, resolveProxy: async () => 'DIRECT', commandLine: { getSwitchValue: () => '', appendSwitch: vi.fn() } },
  session: { defaultSession: { setCertificateVerifyProc: vi.fn() } },
  utilityProcess: { fork: (_module: string, _args: string[], options: unknown) => { const host = new FakeProcess(); host.options = options; electron.forks.push(host); return host } }
}))

vi.mock('../../sessions/web-request-owner.js', () => ({
  RUN_LAST: Number.MAX_SAFE_INTEGER,
  webRequestOwnerFor: () => ({
    onBeforeSendHeaders: () => ({ remove }),
    onBeforeRequest: () => ({ remove }),
    onCompleted: () => ({ remove }),
    onResponseStarted: () => ({ remove }),
    onErrorOccurred: () => ({ remove })
  })
}))

vi.mock('../checkpoint-fetch-net.js', () => ({ beaconJson: async () => { throw new Error('unreachable') } }))
vi.mock('../../dev/eth-resolver.js', () => ({ devEthNames: () => ({ names: [], rules: '', secureOrigins: '' }), isDevEthName: () => false }))

const forks = (): FakeProcess[] => electron.forks as FakeProcess[]
type Started = { config?: { lightClient?: { executionRpcs?: string[] } } }
const started = (index: number): Started | undefined => (forks()[index]?.sent as Array<{ type: string } & Started>).find((message) => message.type === 'start')

/** The subsystem with a host running, and a way to name the person's execution RPC. */
async function launched (lightClientEnabled: () => boolean) {
  vi.resetModules()
  vi.setSystemTime(SHIPPED_AT_MS + DAY_MS)
  const subsystem = await import('../verifier-subsystem.js')
  await subsystem.verifierSubsystem.afterReady?.({} as never)
  let rpcs = ''
  subsystem.configureVerifier({
    lightClientEnabled,
    windows: () => [],
    servedFromCache: () => false,
    ethServers: () => effectiveEthServers({ choice: rpcs === '' ? 'orivon' : 'custom', rpcs, beacon: '' })
  })
  void subsystem.verifierContentAddress('https://vitalik.eth').catch(() => {})
  await vi.advanceTimersByTimeAsync(0)
  forks()[0]?.listens()
  return { subsystem, name: (next: string) => { rpcs = next } }
}

/** The host that was put to sleep exits, and the next ask starts another. */
async function startAgain (subsystem: { verifierContentAddress: (origin: string) => Promise<unknown> }): Promise<void> {
  forks()[0]?.emit('exit', 0)
  void subsystem.verifierContentAddress('https://vitalik.eth').catch(() => {})
  await vi.advanceTimersByTimeAsync(0)
}

describe('the Ethereum servers the person named, as the verifier subsystem applies them', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    electron.forks.length = 0
    electron.userData = mkdtempSync(join(tmpdir(), 'orivon-eth-servers-test-'))
    delete process.env['ORIVON_ETH_LIGHT_CLIENT']
    delete process.env['ORIVON_TEST_ETH_FIXTURES']
  })
  afterEach(() => { vi.useRealTimers(); delete process.env['ORIVON_VERIFIER_LOG'] })

  it('puts the host to sleep when the servers asked change, and its next start asks the new ones', async () => {
    const { subsystem, name } = await launched(() => true)
    expect(started(0)?.config?.lightClient?.executionRpcs).not.toContain(RPC)
    name(RPC)
    subsystem.ethServersChanged()
    expect(forks()[0]?.killed).toBe(true)
    await startAgain(subsystem)
    expect(started(1)?.config?.lightClient?.executionRpcs).toEqual([RPC])
  })

  it('leaves a running host alone while the light client is switched off, since its config holds no servers, and the view still follows', async () => {
    let enabled = false
    const { subsystem, name } = await launched(() => enabled)
    const heard = vi.fn()
    subsystem.onVerifierChange(heard)
    name(RPC)
    subsystem.ethServersChanged()
    expect(forks()[0]?.killed).toBe(false)
    expect(heard).toHaveBeenCalled()
    expect(subsystem.verifierView().endpoints[0]?.urls).toEqual([RPC])
    enabled = true
    subsystem.lightClientSettingChanged()
    expect(forks()[0]?.killed).toBe(true)
    await startAgain(subsystem)
    expect(started(1)?.config?.lightClient?.executionRpcs).toEqual([RPC])
  })

  it('forks the host with piped output, and what it prints becomes lines of main\'s own log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await launched(() => true)
      expect(forks()[0]?.options).toMatchObject({ serviceName: 'Orivon verifier', stdio: 'pipe' })
      forks()[0]?.stderr.emit('data', Buffer.from('[verifier] swarm: a site mounted in 12 ms\nan uncaught thing\n'))
      expect(warn).toHaveBeenCalledWith('[verifier] swarm: a site mounted in 12 ms')
      expect(warn).toHaveBeenCalledWith('[verifier] an uncaught thing')
    } finally {
      warn.mockRestore()
    }
  })

  it('writes a failure the host prints every few seconds once, with the number of times it came again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await launched(() => true)
      forks()[0]?.stderr.emit('data', Buffer.from('[verifier] light client refresh failed: timeout\n'.repeat(100) + '[verifier] light client synced\n'))
      expect(warn.mock.calls.map(([text]) => String(text)).filter((text) => text.includes('light client') || text.includes('repeated'))).toEqual([
        '[verifier] light client refresh failed: timeout',
        '[verifier] the line above repeated 99 times',
        '[verifier] light client synced'
      ])
    } finally {
      warn.mockRestore()
    }
  })

  it('writes every line the host prints, repeats included, when ORIVON_VERIFIER_LOG=1', async () => {
    process.env['ORIVON_VERIFIER_LOG'] = '1'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await launched(() => true)
      forks()[0]?.stderr.emit('data', Buffer.from('[verifier] light client refresh failed: timeout\n'.repeat(100)))
      expect(warn.mock.calls.filter(([text]) => String(text).includes('refresh failed'))).toHaveLength(100)
    } finally {
      warn.mockRestore()
    }
  })
})
