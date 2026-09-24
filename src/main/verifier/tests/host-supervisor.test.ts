import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import type { HostConfig } from '../../../verifier-host/protocol.js'
import { HostSupervisor } from '../host-supervisor.js'
import type { HostProcess, SupervisorEvents } from '../host-supervisor.js'

const CONFIG: HostConfig = { port: 1, lightClient: undefined, gateways: ['https://g.example'], ipnsNameServices: [], dnsOverHttps: [], ipnsSequences: {} }

class FakeHost extends EventEmitter implements HostProcess {
  readonly sent: unknown[] = []
  killed = false
  postMessage (message: unknown): void { this.sent.push(message) }
  kill (): boolean { this.killed = true; return true }
  answer (message: unknown): void { this.emit('message', message) }
  crash (code = 1): void { this.emit('exit', code) }
}

function harness (): { supervisor: HostSupervisor, hosts: FakeHost[], timers: Array<{ ms: number, run: () => void }>, log: string[], clock: { now: number } } {
  const hosts: FakeHost[] = []
  const timers: Array<{ ms: number, run: () => void }> = []
  const log: string[] = []
  const clock = { now: 0 }
  const events: SupervisorEvents = {
    listening: (f) => log.push(`listening ${f}`),
    down: (r) => log.push(`down ${r}`),
    status: (s) => log.push(`status ${s.state}`),
    checkpoint: (r, t) => log.push(`checkpoint ${r} ${String(t)}`),
    ipnsSequence: (k, s) => log.push(`ipns ${k} ${s}`)
  }
  const supervisor = new HostSupervisor({
    fork: () => { const h = new FakeHost(); hosts.push(h); return h },
    config: () => CONFIG,
    events,
    setTimer: (run, ms) => { timers.push({ run, ms }) },
    now: () => clock.now
  })
  return { supervisor, hosts, timers, log, clock }
}

describe('HostSupervisor', () => {
  it('forks the host once and hands it its config', () => {
    const { supervisor, hosts } = harness()
    supervisor.start()
    supervisor.start()
    expect(hosts).toHaveLength(1)
    expect(hosts[0]?.sent).toEqual([{ type: 'start', config: CONFIG }])
  })

  it('passes on what the host reports', () => {
    const { supervisor, hosts, log } = harness()
    supervisor.start()
    hosts[0]?.answer({ type: 'listening', fingerprint: 'sha256/x' })
    hosts[0]?.answer({ type: 'status', status: { state: 'syncing', since: 1 } })
    hosts[0]?.answer({ type: 'checkpoint', root: '0xab', timestamp: 5 })
    hosts[0]?.answer({ type: 'ipns-sequence', key: 'k51', sequence: '7' })
    hosts[0]?.answer({ type: 'failed', stage: 'listen', message: 'EADDRINUSE' })
    expect(log).toEqual(['listening sha256/x', 'status syncing', 'checkpoint 0xab 5', 'ipns k51 7', 'down the verifier host could not listen on its port: EADDRINUSE'])
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
    const reply = supervisor.request({ kind: 'provenance', host: 'a.eth' })
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
})
