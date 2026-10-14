import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startSocks5Fixture } from '../../../broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../../broker/route/tests/socks5-fixture.test-helpers.js'
import type { FromHost, NymTunnelConfig } from '../../../protocols/nym-tunnel/protocol.js'
import type { HostProcess } from '../../verifier/process-supervisor.js'
import { createNymSubsystem, LISTEN_WAIT_MS, NymUnavailable, RECYCLE_AFTER_STARTS, STOP_AFTER_LAST_TUNNEL_MS } from '../nym-subsystem.js'
import type { NymDeps, NymSubsystem } from '../nym-subsystem.js'
import { isFromHost } from '../nym-messages.js'

class FakeProcess implements HostProcess {
  readonly posted: Array<{ type: string, config?: NymTunnelConfig }> = []
  killed = false
  private messageListener: ((message: unknown) => void) | undefined
  private exitListener: ((code: number) => void) | undefined
  postMessage = (message: unknown): void => { this.posted.push(message as { type: string }) }
  on = ((event: 'message' | 'exit', listener: never): void => {
    if (event === 'message') this.messageListener = listener
    else this.exitListener = listener
  }) as HostProcess['on']
  kill = (): boolean => { this.killed = true; queueMicrotask(() => { this.exitListener?.(0) }); return true }
  say (message: FromHost): void { this.messageListener?.(message) }
  get config (): NymTunnelConfig | undefined { return this.posted.find((entry) => entry.type === 'start')?.config }
}

interface Timer { readonly callback: () => void, readonly ms: number, cancelled: boolean }

function harness (overrides: Partial<NymDeps> = {}) {
  const processes: FakeProcess[] = []
  const timers: Timer[] = []
  let ports = 31_000
  const nym: NymSubsystem = createNymSubsystem({
    fork: () => { const child = new FakeProcess(); processes.push(child); return child },
    artifact: async () => ({ ok: true, directory: '/module' }),
    files: () => [{ name: 'smolmix_wasm.js', bytes: 1, sha256: 'ab' }],
    proxyConfigured: async () => false,
    freshPort: () => ports++,
    maxInstances: 6,
    setTimer: (callback, ms) => { const timer: Timer = { callback, ms, cancelled: false }; timers.push(timer); return timer },
    clearTimer: (timer) => { (timer as Timer).cancelled = true },
    ...overrides
  })
  const live = (): Timer[] => timers.filter((timer) => !timer.cancelled)
  const settle = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 5)) }
  return { nym, processes, timers, live, settle }
}

describe('the Nym tunnel as the shell reaches it', () => {
  it('forks the host at the first ask, with a quiet port and a secret made for that start, and answers once it listens', async () => {
    const { nym, processes, settle } = harness()
    const asked = nym.ensure()
    await settle()
    expect(processes).toHaveLength(1)
    const config = processes[0]?.config
    expect(config).toMatchObject({ moduleDir: '/module', port: 31_000, maxInstances: 6 })
    expect(config?.secret).toMatch(/^[0-9a-f]{48}$/)
    expect(nym.state()).toEqual({ state: 'connecting' })
    processes[0]?.say({ type: 'listening' })
    expect(await asked).toEqual({ port: 31_000, secret: config?.secret })
    expect(nym.state()).toEqual({ state: 'idle' })
  })

  it('does not fork a second host for a second ask, and follows the tunnels the host reports', async () => {
    const { nym, processes, settle } = harness()
    const first = nym.ensure()
    await settle()
    processes[0]?.say({ type: 'listening' })
    const endpoint = await first
    expect(await nym.ensure()).toEqual(endpoint)
    expect(processes).toHaveLength(1)

    processes[0]?.say({ type: 'instances', connecting: 1, ready: 0, started: 1 })
    expect(nym.state()).toEqual({ state: 'connecting' })
    processes[0]?.say({ type: 'instances', connecting: 0, ready: 1, started: 1 })
    expect(nym.state()).toEqual({ state: 'ready' })
  })

  it('waits for a host that is still coming up, for every ask made meanwhile', async () => {
    const { nym, processes, settle } = harness()
    const a = nym.ensure()
    const b = nym.ensure()
    await settle()
    expect(processes).toHaveLength(1)
    processes[0]?.say({ type: 'listening' })
    expect(await a).toEqual(await b)
  })

  it('stops the host ten minutes after the last tunnel is gone, and starts a new one with another port and secret at the next ask', async () => {
    const { nym, processes, live, settle } = harness()
    const first = nym.ensure()
    await settle()
    processes[0]?.say({ type: 'listening' })
    const before = await first
    processes[0]?.say({ type: 'instances', connecting: 0, ready: 1, started: 1 })
    expect(live().some((timer) => timer.ms === STOP_AFTER_LAST_TUNNEL_MS)).toBe(false)
    processes[0]?.say({ type: 'instances', connecting: 0, ready: 0, started: 1 })
    const stop = live().find((timer) => timer.ms === STOP_AFTER_LAST_TUNNEL_MS)
    expect(stop).toBeDefined()
    stop?.callback()
    await settle()
    expect(processes[0]?.killed).toBe(true)
    expect(nym.state()).toEqual({ state: 'off' })

    const next = nym.ensure()
    await settle()
    expect(processes).toHaveLength(2)
    processes[1]?.say({ type: 'listening' })
    const after = await next
    expect(after.port).not.toBe(before.port)
    expect(after.secret).not.toBe(before.secret)
  })

  it('keeps the host when a tunnel opens before the ten minutes are up', async () => {
    const { nym, processes, live, settle } = harness()
    const first = nym.ensure()
    await settle()
    processes[0]?.say({ type: 'listening' })
    await first
    processes[0]?.say({ type: 'instances', connecting: 0, ready: 0, started: 1 })
    processes[0]?.say({ type: 'instances', connecting: 1, ready: 0, started: 1 })
    expect(live().some((timer) => timer.ms === STOP_AFTER_LAST_TUNNEL_MS)).toBe(false)
  })

  it('shows a notice while tunnels work, and replaces the host once it has started as many as it should hold in memory', async () => {
    const { nym, processes, live, settle } = harness()
    const first = nym.ensure()
    await settle()
    processes[0]?.say({ type: 'listening' })
    await first
    processes[0]?.say({ type: 'instances', connecting: 0, ready: 1, started: 7, problem: '6 apps already have a Nym tunnel open' })
    expect(nym.state()).toEqual({ state: 'ready', reason: '6 apps already have a Nym tunnel open' })
    processes[0]?.say({ type: 'instances', connecting: 0, ready: 0, started: RECYCLE_AFTER_STARTS })
    await settle()
    expect(processes[0]?.killed, 'stopped at once, not after ten minutes').toBe(true)
    expect(live().some((timer) => timer.ms === STOP_AFTER_LAST_TUNNEL_MS)).toBe(false)
    expect(nym.state()).toEqual({ state: 'off' })
  })

  it('stops the host and refuses when a proxy is set while it runs', async () => {
    let proxy = false
    let now = 1_000
    const { nym, processes, settle } = harness({ proxyConfigured: async () => proxy, now: () => now })
    const first = nym.ensure()
    await settle()
    processes[0]?.say({ type: 'listening' })
    await first
    proxy = true
    expect(await nym.ensure(), 'the answer of a moment ago is reused').toBeDefined()
    now += 5_001
    await expect(nym.ensure()).rejects.toThrow(/proxy is configured/)
    await settle()
    expect(processes[0]?.killed).toBe(true)
    expect(nym.state()).toMatchObject({ state: 'unavailable', cause: 'proxy' })
  })

  it('is unavailable, and forks nothing, when the module is not in this build', async () => {
    const { nym, processes } = harness({ artifact: async () => ({ ok: false, reason: 'the Nym tunnel\'s file smolmix_wasm.js is missing from /x; run node scripts/fetch-local-nodes.mjs to fetch it' }) })
    await expect(nym.ensure()).rejects.toBeInstanceOf(NymUnavailable)
    expect(processes).toHaveLength(0)
    expect(nym.state()).toMatchObject({ state: 'unavailable', cause: 'not-in-build' })
  })

  it('is unavailable with the reason when a proxy is configured, because its connections would go around it', async () => {
    const { nym, processes } = harness({ proxyConfigured: async () => true })
    await expect(nym.ensure()).rejects.toThrow(/proxy is configured/)
    expect(processes).toHaveLength(0)
    expect(nym.state()).toMatchObject({ state: 'unavailable', cause: 'proxy' })
  })

  it('is unavailable in a build that says so', async () => {
    const { nym } = harness({ disabled: () => 'a test build runs no Nym' })
    await expect(nym.ensure()).rejects.toThrow('a test build runs no Nym')
    expect(nym.state()).toMatchObject({ state: 'unavailable', cause: 'other' })
  })

  it('answers a refusal from memory for ten seconds, and looks again after', async () => {
    let looks = 0
    let now = 1_000
    const { nym } = harness({ artifact: async () => { looks += 1; return { ok: false, reason: 'missing' } }, now: () => now })
    await expect(nym.ensure()).rejects.toThrow()
    await expect(nym.ensure()).rejects.toThrow()
    expect(looks).toBe(1)
    now += 10_001
    await expect(nym.ensure()).rejects.toThrow()
    expect(looks).toBe(2)
  })

  it('fails with the host\'s reason when it cannot run, and refuses the ask that was waiting', async () => {
    const { nym, processes, settle } = harness()
    const asked = nym.ensure().catch((error: unknown) => error)
    await settle()
    processes[0]?.say({ type: 'failed', stage: 'load', message: 'the module would not start' })
    await settle()
    expect(await asked).toBeInstanceOf(NymUnavailable)
    expect(nym.state()).toMatchObject({ state: 'failed' })
    expect((nym.state() as { reason: string }).reason).toContain('the module would not start')
  })

  it('says why a tunnel could not come up, and keeps saying it after the host stops', async () => {
    const { nym, processes, live, settle } = harness()
    const first = nym.ensure()
    await settle()
    processes[0]?.say({ type: 'listening' })
    await first
    processes[0]?.say({ type: 'instances', connecting: 0, ready: 0, started: 1, problem: 'no gateway answered' })
    expect(nym.state()).toEqual({ state: 'failed', reason: 'no gateway answered' })
    live().find((timer) => timer.ms === STOP_AFTER_LAST_TUNNEL_MS)?.callback()
    await settle()
    expect(nym.state()).toEqual({ state: 'failed', reason: 'no gateway answered' })
  })

  it('gives up on a host that never listens', async () => {
    const { nym, processes, live, settle } = harness()
    const asked = nym.ensure().catch((error: unknown) => error)
    await settle()
    expect(processes).toHaveLength(1)
    live().find((timer) => timer.ms === LISTEN_WAIT_MS)?.callback()
    expect(await asked).toBeInstanceOf(NymUnavailable)
  })

  it('stops the host with the shell', async () => {
    const { nym, processes, settle } = harness()
    const asked = nym.ensure()
    await settle()
    processes[0]?.say({ type: 'listening' })
    await asked
    nym.stop()
    expect(processes[0]?.killed).toBe(true)
  })
})

describe('the Test of Nym', () => {
  let fixture: Socks5Fixture | undefined
  let echo: ReturnType<typeof createServer> | undefined
  afterEach(async () => {
    await fixture?.close()
    await new Promise<void>((resolve) => { if (echo === undefined) resolve(); else echo.close(() => { resolve() }) })
    fixture = undefined
    echo = undefined
  })

  it('brings Nym up, opens a stream to a name through it, and says how long that took', async () => {
    echo = createServer((socket) => { socket.on('error', () => {}); socket.end() })
    await new Promise<void>((resolve) => { echo?.listen(0, '127.0.0.1', resolve) })
    fixture = await startSocks5Fixture({ preferAuth: true, names: { 'example.com:443': { host: '127.0.0.1', port: (echo.address() as AddressInfo).port } } })
    let clock = 0
    const { nym, processes, settle } = harness({ freshPort: () => fixture?.port ?? 0, now: () => { clock += 250; return clock } })
    const result = nym.test()
    await settle()
    processes[0]?.say({ type: 'listening' })
    const answer = await result
    expect(answer.ok).toBe(true)
    expect(answer.ok ? answer.ms : 0).toBeGreaterThan(0)
    expect(fixture.requests.at(-1)).toMatchObject({ command: 'connect', destination: 'example.com', port: 443, userId: 'orivon-settings-test' })
  })

  it('says it could not when Nym is not available, with the reason', async () => {
    const { nym } = harness({ artifact: async () => ({ ok: false, reason: 'not in this build' }) })
    expect(await nym.test()).toEqual({ ok: false, reason: 'unavailable', detail: 'not in this build' })
  })
})

describe('what the host may say', () => {
  it.each([
    [{ type: 'listening' }, true],
    [{ type: 'instances', connecting: 1, ready: 0, started: 1 }, true],
    [{ type: 'instances', connecting: 0, ready: 2, started: 1, problem: 'why' }, true],
    [{ type: 'failed', stage: 'load', message: 'x' }, true],
    [{ type: 'instances', connecting: -1, ready: 0 }, false],
    [{ type: 'instances', connecting: 'a', ready: 0 }, false],
    [{ type: 'failed', stage: 'elsewhere', message: 'x' }, false],
    [{ type: 'failed', stage: 'load', message: 'x'.repeat(501) }, false],
    [{ type: 'ready' }, false],
    [null, false],
    ['listening', false]
  ])('reads %j as %s', (message, expected) => {
    expect(isFromHost(message)).toBe(expected)
  })
})

describe('what the Networks popup reads of Nym', () => {
  it('keeps how many tunnels are connecting and open from the last report, and forgets them when the host stops', async () => {
    const { nym, processes, settle } = harness()
    expect(nym.tunnels()).toEqual({ connecting: 0, ready: 0 })
    const asked = nym.ensure()
    await settle()
    processes[0]?.say({ type: 'listening' })
    await asked
    processes[0]?.say({ type: 'instances', connecting: 1, ready: 2, started: 3 })
    expect(nym.tunnels()).toEqual({ connecting: 1, ready: 2 })
    nym.stop()
    await settle()
    expect(nym.tunnels()).toEqual({ connecting: 0, ready: 0 })
  })

  it('names the process while it runs, so its memory and age can be read', async () => {
    const { nym, processes, settle } = harness({ now: () => 5_000 })
    expect(nym.processInfo()).toBeUndefined()
    void nym.ensure().catch(() => {})
    await settle()
    expect(processes).toHaveLength(1)
    expect(nym.processInfo()).toEqual({ pid: undefined, startedAt: 5_000 })
  })
})

describe('switching Nym off', () => {
  it('refuses every ask, in words that say where to switch it on, and starts nothing', async () => {
    const { nym, processes } = harness()
    nym.setEnabled(false)
    await expect(nym.ensure()).rejects.toThrow(/switched off.*Settings/)
    expect(processes).toHaveLength(0)
    expect(nym.state()).toMatchObject({ state: 'unavailable', cause: 'other' })
    expect(await nym.test()).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  it('stops a host that runs, so a tunnel is refused rather than carried on', async () => {
    const { nym, processes, settle } = harness()
    const asked = nym.ensure()
    await settle()
    processes[0]?.say({ type: 'listening' })
    await asked
    nym.setEnabled(false)
    await settle()
    expect(processes[0]?.killed).toBe(true)
    await expect(nym.ensure()).rejects.toBeInstanceOf(NymUnavailable)
  })

  it('starts again at the next ask once it is switched back on, without waiting out the memory of the refusal', async () => {
    const { nym, processes, settle } = harness()
    nym.setEnabled(false)
    await expect(nym.ensure()).rejects.toBeInstanceOf(NymUnavailable)
    nym.setEnabled(true)
    expect(nym.state()).toEqual({ state: 'off' })
    const asked = nym.ensure()
    await settle()
    processes[0]?.say({ type: 'listening' })
    await asked
    expect(processes).toHaveLength(1)
  })

  it('starts nothing when it is switched off while the files are being checked, and refuses that ask', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { nym, processes, settle } = harness({ artifact: async () => { await gate; return { ok: true, directory: '/module' } } })
    const asked = nym.ensure()
    const refused = expect(asked).rejects.toThrow(/switched off/)
    await settle()
    nym.setEnabled(false)
    release()
    await refused
    await settle()
    expect(processes).toHaveLength(0)
    expect(nym.state()).toMatchObject({ state: 'unavailable', cause: 'other' })
  })

  it('does not answer an ask with an address when it is switched off while the proxy is being checked', async () => {
    const clock = { now: 1_000 }
    let release: (set: boolean) => void = () => {}
    let calls = 0
    const { nym, processes, settle } = harness({ now: () => clock.now, proxyConfigured: async () => { calls += 1; return calls === 1 ? false : await new Promise<boolean>((resolve) => { release = resolve }) } })
    const first = nym.ensure()
    await settle()
    processes[0]?.say({ type: 'listening' })
    await first
    // The proxy answer is reused for a few seconds: a later ask finds it stale and asks the system again.
    clock.now += 10_000
    const asked = nym.ensure()
    const refused = expect(asked).rejects.toBeInstanceOf(NymUnavailable)
    await settle()
    nym.setEnabled(false)
    release(false)
    await refused
  })
})
