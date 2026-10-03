import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import type { HostConfig } from '../../../protocols/verifier-host/protocol.js'
import { HostSupervisor } from '../host-supervisor.js'
import type { HostProcess, SupervisorEvents } from '../host-supervisor.js'

const CONFIG: HostConfig = { port: 1, lightClient: undefined, gateways: ['https://g.example'], unproxiedGateways: [], ccipDirect: false, ipnsNameServices: [], dnsOverHttps: [], ipnsSequences: {} }

class FakeHost extends EventEmitter implements HostProcess {
  readonly sent: unknown[] = []
  killed = false
  postMessage (message: unknown): void { this.sent.push(message) }
  kill (): boolean { this.killed = true; return true }
  answer (message: unknown): void { this.emit('message', message) }
  crash (code = 1): void { this.emit('exit', code) }
}

function harness (): { supervisor: HostSupervisor, hosts: FakeHost[], timers: Array<{ ms: number, run: () => void }>, log: string[], clock: { now: number }, startings: { count: number } } {
  const hosts: FakeHost[] = []
  const timers: Array<{ ms: number, run: () => void }> = []
  const log: string[] = []
  const startings = { count: 0 }
  const clock = { now: 0 }
  const events: SupervisorEvents = {
    listening: (f) => log.push(`listening ${f}`),
    down: (r) => log.push(`down ${r}`),
    status: (s) => log.push(`status ${s.state}`),
    checkpoint: (r, t) => log.push(`checkpoint ${r} ${String(t)}`),
    ipnsSequence: (k, s) => log.push(`ipns ${k} ${s}`),
    idle: () => log.push('idle'),
    starting: () => { startings.count += 1 }
  }
  const supervisor = new HostSupervisor({
    fork: () => { const h = new FakeHost(); hosts.push(h); return h },
    config: () => CONFIG,
    events,
    setTimer: (run, ms) => { timers.push({ run, ms }) },
    now: () => clock.now
  })
  return { supervisor, hosts, timers, log, clock, startings }
}

describe('HostSupervisor', () => {
  it('forks the host once and hands it its config', () => {
    const { supervisor, hosts } = harness()
    supervisor.start()
    supervisor.start()
    expect(hosts).toHaveLength(1)
    expect(hosts[0]?.sent).toEqual([{ type: 'start', config: CONFIG }])
  })

  it('says the host is starting on the first start and on every restart, before the process is forked', () => {
    const hosts: FakeHost[] = []
    const timers: Array<() => void> = []
    const log: string[] = []
    const supervisor = new HostSupervisor({
      fork: () => { log.push('fork'); const h = new FakeHost(); hosts.push(h); return h },
      config: () => CONFIG,
      events: { starting: () => log.push('starting'), listening: () => {}, down: () => log.push('down'), status: () => {}, checkpoint: () => {}, ipnsSequence: () => {} },
      setTimer: (run) => { timers.push(run) }
    })
    supervisor.start()
    hosts[0]?.crash()
    timers[0]?.()
    expect(log).toEqual(['starting', 'fork', 'down', 'starting', 'fork'])
  })

  it('passes on what the host reports', () => {
    const { supervisor, hosts, log } = harness()
    supervisor.start()
    hosts[0]?.answer({ type: 'listening', fingerprint: 'sha256/x' })
    hosts[0]?.answer({ type: 'status', status: { state: 'syncing', since: 1 } })
    const root = `0x${'ab'.repeat(32)}`
    hosts[0]?.answer({ type: 'checkpoint', root, timestamp: 5 })
    hosts[0]?.answer({ type: 'ipns-sequence', key: 'k51', sequence: '7' })
    hosts[0]?.answer({ type: 'failed', stage: 'listen', message: 'EADDRINUSE' })
    expect(log).toEqual(['listening sha256/x', 'status syncing', `checkpoint ${root} 5`, 'ipns k51 7', 'down the verifier host could not listen on its port: EADDRINUSE'])
  })

  it('drops a message that is not one of the shapes the host may ever post, instead of acting on it', () => {
    const { supervisor, hosts, log } = harness()
    supervisor.start()
    hosts[0]?.answer({ type: 'listening', fingerprint: 42 }) // wrong type for the field
    hosts[0]?.answer({ type: 'checkpoint', root: 'not-a-block-root', timestamp: 5 })
    hosts[0]?.answer({ type: 'ipns-sequence', key: 'k1', sequence: 'not-decimal' })
    hosts[0]?.answer({ type: 'something-else' })
    hosts[0]?.answer('just a string')
    expect(log).toEqual([])
  })

  it('rejects a reply whose value is not the shape its own request kind promises', async () => {
    const { supervisor, hosts } = harness()
    supervisor.start()
    const reply = supervisor.request({ kind: 'status' })
    const sent = hosts[0]?.sent[1] as { id: number }
    // 'status' promises a LightClientState, never a SiteProvenance -- this looks like one, but for the wrong request.
    hosts[0]?.answer({ type: 'reply', id: sent.id, ok: true, value: { host: 'x.eth', resolver: 'ens', root: { kind: 'ipfs', cid: 'bafy' }, pointers: [], ddoc: { status: 'met', refusals: [] }, mountedAt: 1 } })
    await expect(reply).rejects.toThrow(/status.*not one/)
  })

  it('matches replies to requests', async () => {
    const { supervisor, hosts } = harness()
    supervisor.start()
    const reply = supervisor.request({ kind: 'status' })
    const sent = hosts[0]?.sent[1] as { id: number }
    hosts[0]?.answer({ type: 'reply', id: sent.id, ok: true, value: { state: 'off' } })
    expect(await reply).toEqual({ state: 'off' })
  })

  it('rejects a request the host never answers, when its deadline passes', async () => {
    const { supervisor, timers } = harness()
    supervisor.start()
    const reply = supervisor.request({ kind: 'status' }, 100)
    timers.find((t) => t.ms === 100)?.run()
    await expect(reply).rejects.toThrow(/did not answer status within 100 ms/)
  })

  it('rejects a request while the host is down, and every pending one when it exits', async () => {
    const { supervisor, hosts } = harness()
    await expect(supervisor.request({ kind: 'status' })).rejects.toThrow(/not running/)
    supervisor.start()
    const reply = supervisor.request({ kind: 'provenance', host: 'a.eth', partition: 'https://a.eth' })
    hosts[0]?.crash(9)
    await expect(reply).rejects.toThrow(/exited with code 9/)
  })

  it('restarts after a crash, backing off, and resets the backoff after a stable run', () => {
    const { supervisor, hosts, timers, log, clock } = harness()
    supervisor.start()
    hosts[0]?.crash()
    expect(log).toContain('down the verifier host exited with code 1')
    expect(timers.at(-1)?.ms).toBe(1000)
    timers.at(-1)?.run()
    expect(hosts).toHaveLength(2)
    hosts[1]?.crash()
    expect(timers.at(-1)?.ms).toBe(2000)
    timers.at(-1)?.run()
    clock.now = 120_000
    hosts[2]?.crash()
    expect(timers.at(-1)?.ms).toBe(1000)
  })

  it('kills a host that could not serve, keeps its reason, and restarts it', () => {
    const { supervisor, hosts, timers, log } = harness()
    supervisor.start()
    hosts[0]?.answer({ type: 'failed', stage: 'listen', message: 'EADDRINUSE' })
    expect(hosts[0]?.killed).toBe(true)
    hosts[0]?.crash(0)
    expect(log.at(-1)).toBe('down the verifier host could not listen on its port: EADDRINUSE')
    timers.at(-1)?.run()
    expect(hosts).toHaveLength(2)
  })

  it('does not restart once stopped', () => {
    const { supervisor, hosts, timers } = harness()
    supervisor.start()
    supervisor.stop()
    expect(hosts[0]?.killed).toBe(true)
    hosts[0]?.crash()
    expect(timers).toHaveLength(0)
  })

  it('an async config posts once it resolves, and request() waits for it rather than racing ahead', async () => {
    const hosts: FakeHost[] = []
    let resolveConfig!: (config: HostConfig) => void
    const supervisor = new HostSupervisor({
      fork: () => { const h = new FakeHost(); hosts.push(h); return h },
      config: async () => await new Promise<HostConfig>((resolve) => { resolveConfig = resolve }),
      events: { listening: () => {}, down: () => {}, status: () => {}, checkpoint: () => {}, ipnsSequence: () => {} }
    })
    supervisor.start()
    expect(hosts[0]?.sent).toEqual([]) // nothing posted yet -- the config hasn't resolved
    const reply = supervisor.request({ kind: 'status' })
    resolveConfig(CONFIG)
    // A few microtask turns: the config promise resolving, its own async
    // wrapper unwrapping that, and this class's .then() running in turn.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(hosts[0]?.sent).toEqual([{ type: 'start', config: CONFIG }, { type: 'request', id: expect.any(Number), request: { kind: 'status' } }])
    const sent = hosts[0]?.sent[1] as { id: number }
    hosts[0]?.answer({ type: 'reply', id: sent.id, ok: true, value: { state: 'off' } })
    expect(await reply).toEqual({ state: 'off' })
  })

  it('an async config that rejects kills the host without posting start, then restarts it once it exits', async () => {
    const hosts: FakeHost[] = []
    const log: string[] = []
    const timers: Array<{ ms: number, run: () => void }> = []
    let rejectOnce = true
    const supervisor = new HostSupervisor({
      fork: () => { const h = new FakeHost(); hosts.push(h); return h },
      config: async () => {
        if (!rejectOnce) return CONFIG
        rejectOnce = false
        throw new Error('the verifier store is corrupt')
      },
      events: { listening: () => {}, down: (r) => log.push(r), status: () => {}, checkpoint: () => {}, ipnsSequence: () => {} },
      setTimer: (run, ms) => { timers.push({ run, ms }) }
    })
    supervisor.start()
    const pending = supervisor.request({ kind: 'status' }, 60_000)
    await Promise.resolve()
    await Promise.resolve()
    expect(hosts[0]?.sent.filter((m) => (m as { type: string }).type === 'start')).toEqual([])
    expect(hosts[0]?.killed).toBe(true)
    expect(log.at(-1)).toMatch(/could not be prepared.*the verifier store is corrupt/)

    hosts[0]?.crash(0) // what kill() leads to
    await expect(pending).rejects.toThrow(/could not be prepared/)
    expect(timers.filter((t) => t.ms === 1_000)).toHaveLength(1) // the backoff restart
    timers.find((t) => t.ms === 1_000)?.run()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(hosts).toHaveLength(2)
    expect(hosts[1]?.sent).toEqual([{ type: 'start', config: CONFIG }])
    hosts[1]?.crash(3)
    expect(log.at(-1)).toBe('the verifier host exited with code 3') // the first host's failure did not stick
  })

  describe('idle', () => {
    it('kills the host without calling it down, rejects what is pending, and does not restart', async () => {
      const { supervisor, hosts, timers, log } = harness()
      supervisor.start()
      const reply = supervisor.request({ kind: 'status' })
      supervisor.idle()
      expect(hosts[0]?.killed).toBe(true)
      expect(log).toContain('idle')
      hosts[0]?.crash(0)
      await expect(reply).rejects.toThrow(/idle/)
      expect(log.some((line) => line.startsWith('down'))).toBe(false)
      expect(timers.filter((t) => t.ms === 1000)).toHaveLength(0)
      await expect(supervisor.request({ kind: 'status' })).rejects.toThrow(/not running/)
    })

    it('lets a later start fork a fresh host, and says it is starting', () => {
      const { supervisor, hosts, startings } = harness()
      supervisor.start()
      supervisor.idle()
      hosts[0]?.crash(0)
      startings.count = 0
      supervisor.start()
      expect(hosts).toHaveLength(2)
      expect(startings.count).toBe(1)
      expect(hosts[1]?.sent).toEqual([{ type: 'start', config: CONFIG }])
    })

    it('forks the fresh host only once the old one has exited, so they never share the port', () => {
      const { supervisor, hosts } = harness()
      supervisor.start()
      supervisor.idle()
      supervisor.start()
      expect(hosts).toHaveLength(1)
      hosts[0]?.crash(0)
      expect(hosts).toHaveLength(2)
    })

    it('ignores what the old host still says after it was put to sleep', () => {
      const { supervisor, hosts, log } = harness()
      supervisor.start()
      supervisor.idle()
      log.length = 0
      hosts[0]?.answer({ type: 'listening', fingerprint: 'sha256/old=' })
      expect(log).toEqual([])
    })

    it('does not count as a crash: the next crash backs off from the start', () => {
      const { supervisor, hosts, timers } = harness()
      supervisor.start()
      hosts[0]?.crash()
      timers.at(-1)?.run()
      hosts[1]?.crash()
      expect(timers.at(-1)?.ms).toBe(2000)
      timers.at(-1)?.run()
      supervisor.idle()
      hosts[2]?.crash(0)
      supervisor.start()
      hosts[3]?.crash()
      expect(timers.at(-1)?.ms).toBe(1000)
    })

    it('cancels a restart that was waiting out its backoff', () => {
      const { supervisor, hosts, timers, log } = harness()
      supervisor.start()
      hosts[0]?.crash()
      supervisor.idle()
      expect(log).toContain('idle')
      timers.at(-1)?.run()
      expect(hosts).toHaveLength(1)
    })

    it('does nothing when the host was never started, and never undoes stop', () => {
      const { supervisor, hosts, log } = harness()
      supervisor.idle()
      expect(log).toEqual([])
      supervisor.start()
      supervisor.stop()
      supervisor.idle()
      hosts[0]?.crash()
      supervisor.start()
      expect(hosts).toHaveLength(1)
    })

    it('a config that was still being prepared posts nothing to the host that was put to sleep', async () => {
      const hosts: FakeHost[] = []
      let resolveConfig!: (config: HostConfig) => void
      const supervisor = new HostSupervisor({
        fork: () => { const h = new FakeHost(); hosts.push(h); return h },
        config: async () => await new Promise<HostConfig>((resolve) => { resolveConfig = resolve }),
        events: { listening: () => {}, down: () => {}, status: () => {}, checkpoint: () => {}, ipnsSequence: () => {} }
      })
      supervisor.start()
      supervisor.idle()
      resolveConfig(CONFIG)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(hosts[0]?.sent).toEqual([])
    })
  })
})
