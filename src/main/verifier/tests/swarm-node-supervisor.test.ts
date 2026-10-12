import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { SwarmNodeConfig } from '../../../protocols/swarm-node/protocol.js'
import type { HostProcess } from '../process-supervisor.js'
import { RefusedToStart } from '../process-supervisor.js'
import { SwarmNodeSupervisor } from '../swarm-node-supervisor.js'

const CONFIG: SwarmNodeConfig = { apiPort: 1, dataDir: '/d', componentDir: '/c', componentName: 'swarm-node', files: [] }

class FakeNode extends EventEmitter implements HostProcess {
  readonly sent: unknown[] = []
  killed = false
  postMessage (message: unknown): void { this.sent.push(message) }
  kill (): boolean { this.killed = true; return true }
}

function harness (): { supervisor: SwarmNodeSupervisor, nodes: FakeNode[], log: string[], timers: Array<{ ms: number, run: () => void }> } {
  const nodes: FakeNode[] = []
  const log: string[] = []
  const timers: Array<{ ms: number, run: () => void }> = []
  const supervisor = new SwarmNodeSupervisor({
    fork: () => { const node = new FakeNode(); nodes.push(node); return node },
    config: () => CONFIG,
    events: {
      starting: () => log.push('starting'),
      idle: () => log.push('idle'),
      listening: () => log.push('listening'),
      peers: (count) => log.push(`peers ${String(count)}`),
      ready: (peers) => log.push(`ready ${String(peers)}`),
      down: (reason) => log.push(`down ${reason}`)
    },
    setTimer: (run, ms) => { timers.push({ run, ms }) }
  })
  return { supervisor, nodes, log, timers }
}

describe('SwarmNodeSupervisor', () => {
  it('forks the node once and hands it its config', () => {
    const { supervisor, nodes } = harness()
    supervisor.start()
    supervisor.start()
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.sent).toEqual([{ type: 'start', config: CONFIG }])
  })

  it('passes on what the node reports, and nothing it should not', () => {
    const { supervisor, nodes, log } = harness()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    supervisor.start()
    for (const message of [{ type: 'listening' }, { type: 'peers', count: 4 }, { type: 'ready', peers: 8 }, { type: 'peers', count: -3 }, { type: 'checkpoint', root: '0x00', timestamp: 1 }, 'ready']) nodes[0]?.emit('message', message)
    errors.mockRestore()
    expect(log).toEqual(['starting', 'listening', 'peers 4', 'ready 8'])
  })

  it('names the failure a node reports, kills it, and restarts it on the backoff', () => {
    const { supervisor, nodes, log, timers } = harness()
    supervisor.start()
    nodes[0]?.emit('message', { type: 'failed', stage: 'run', message: 'trapped' })
    expect(nodes[0]?.killed).toBe(true)
    nodes[0]?.emit('exit', 1)
    expect(log).toEqual(['starting', 'down the Swarm node could not run (run): trapped'])
    expect(timers.map((timer) => timer.ms)).toEqual([1000])
    timers[0]?.run()
    expect(nodes).toHaveLength(2)
  })

  it('says why a node that exited without a word did', () => {
    const { supervisor, nodes, log } = harness()
    supervisor.start()
    nodes[0]?.emit('exit', 139)
    expect(log.at(-1)).toBe('down the Swarm node exited with code 139')
  })

  it('sleeps without counting a failure, and a later start forks a fresh node after the old one has left', () => {
    const { supervisor, nodes, log, timers } = harness()
    supervisor.start()
    supervisor.idle()
    expect(nodes[0]?.killed).toBe(true)
    expect(log).toEqual(['starting', 'idle'])
    supervisor.start()
    expect(nodes).toHaveLength(1)
    nodes[0]?.emit('exit', 0)
    expect(nodes).toHaveLength(2)
    expect(timers).toEqual([])
  })

  it.each(['artifact', 'compile', 'port'] as const)('does not restart a node that failed at its %s stage, until it is started again', (stage) => {
    const { supervisor, nodes, log, timers } = harness()
    supervisor.start()
    nodes[0]?.emit('message', { type: 'failed', stage, message: 'cannot' })
    nodes[0]?.emit('exit', 1)
    expect(timers).toEqual([])
    expect(log.filter((line) => line.startsWith('down'))).toEqual([`down the Swarm node could not run (${stage}): cannot`])
    supervisor.start()
    expect(nodes).toHaveLength(2)
  })

  it.each(['start', 'run'] as const)('restarts a node that failed at its %s stage, on the backoff, and says so once', (stage) => {
    const { supervisor, nodes, log, timers } = harness()
    supervisor.start()
    nodes[0]?.emit('message', { type: 'failed', stage, message: 'crashed' })
    nodes[0]?.emit('exit', 1)
    expect(timers.map((timer) => timer.ms)).toEqual([1000])
    expect(log.filter((line) => line.startsWith('down'))).toHaveLength(1)
  })

  it('tells down whether the node will be started again', () => {
    const restarting: boolean[] = []
    const nodes: FakeNode[] = []
    const supervisor = new SwarmNodeSupervisor({
      fork: () => { const node = new FakeNode(); nodes.push(node); return node },
      config: () => CONFIG,
      events: { listening: () => {}, peers: () => {}, ready: () => {}, down: (_reason, again) => restarting.push(again) },
      setTimer: () => {}
    })
    supervisor.start()
    nodes[0]?.emit('exit', 139)
    nodes[0]?.emit('exit', 0)
    expect(restarting).toEqual([true])
    supervisor.start()
    expect(nodes).toHaveLength(1)
  })

  it('reports a config that refuses once, forks no restart for it, and starts again when asked', async () => {
    const log: string[] = []
    const nodes: FakeNode[] = []
    const timers: number[] = []
    let refuse = true
    const supervisor = new SwarmNodeSupervisor({
      fork: () => { const node = new FakeNode(); nodes.push(node); return node },
      config: async () => { if (refuse) throw new RefusedToStart('a proxy is configured'); return CONFIG },
      events: { listening: () => {}, peers: () => {}, ready: () => {}, down: (reason, again) => log.push(`${reason} restarting=${String(again)}`) },
      setTimer: (_run, ms) => { timers.push(ms) }
    })
    supervisor.start()
    await new Promise((resolve) => setImmediate(resolve))
    expect(nodes[0]?.killed).toBe(true)
    nodes[0]?.emit('exit', 0)
    expect(log).toEqual(['a proxy is configured restarting=false'])
    expect(timers).toEqual([])
    refuse = false
    supervisor.start()
    expect(nodes).toHaveLength(2)
  })

  it('still restarts, on the backoff, after a config that failed for any other reason', async () => {
    const timers: number[] = []
    const nodes: FakeNode[] = []
    const supervisor = new SwarmNodeSupervisor({
      fork: () => { const node = new FakeNode(); nodes.push(node); return node },
      config: async () => { throw new Error('the profile is read-only') },
      events: { listening: () => {}, peers: () => {}, ready: () => {}, down: () => {} },
      setTimer: (_run, ms) => { timers.push(ms) }
    })
    supervisor.start()
    await new Promise((resolve) => setImmediate(resolve))
    nodes[0]?.emit('exit', 0)
    expect(timers).toEqual([1000])
  })

  it('forks no node for a start that was queued behind one still leaving when the node is put to sleep again', () => {
    const { supervisor, nodes, log } = harness()
    supervisor.start()
    supervisor.idle()
    supervisor.start()
    expect(nodes).toHaveLength(1)
    supervisor.idle()
    nodes[0]?.emit('exit', 0)
    expect(nodes).toHaveLength(1)
    expect(log).toEqual(['starting', 'idle', 'starting', 'idle'])
    supervisor.start()
    expect(nodes).toHaveLength(2)
  })
})
