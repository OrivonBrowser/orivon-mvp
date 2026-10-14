import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FromNode, LocalNodeConfig } from '../../../protocols/local-node/protocol.js'
import { SWARM_NODE_IDENTITY } from '../../../protocols/swarm-node/protocol.js'
import type { HostProcess } from '../process-supervisor.js'
import type { ArtifactStatus } from '../local-node-artifact.js'
import { READY_WAIT_MS, REFUSAL_MEMORY_MS, LocalNodeController, proxyReason } from '../local-node-controller.js'
import type { ControllerDeps } from '../local-node-controller.js'

const PROXY_REASON = proxyReason(SWARM_NODE_IDENTITY)

class FakeNode extends EventEmitter implements HostProcess {
  readonly sent: unknown[] = []
  killed = false
  postMessage (message: unknown): void { this.sent.push(message) }
  kill (): boolean { this.killed = true; return true }
  say (message: unknown): void { this.emit('message', message) }
  exit (code = 0): void { this.emit('exit', code) }
}

interface Harness {
  readonly controller: LocalNodeController
  readonly nodes: FakeNode[]
  readonly sleeps: Array<{ ms: number, wake: () => void }>
  readonly timers: Array<{ ms: number, run: () => void }>
  artifact: ArtifactStatus
  proxy: boolean | 'throws'
  disabled: string | undefined
  readonly calls: { artifact: number, proxy: number }
  readonly portsTaken: number[]
  readonly clock: { now: number }
}

function harness (options?: () => Readonly<Record<string, string>>, removed?: string[], extra: Partial<ControllerDeps> = {}): Harness {
  const nodes: FakeNode[] = []
  const sleeps: Harness['sleeps'] = []
  const timers: Harness['timers'] = []
  const state = { artifact: { ok: true, directory: '/artifact' } as ArtifactStatus, proxy: false as boolean | 'throws', disabled: undefined as string | undefined }
  const calls = { artifact: 0, proxy: 0 }
  const portsTaken: number[] = []
  const clock = { now: 1_000_000 }
  const deps: ControllerDeps = {
    kind: SWARM_NODE_IDENTITY,
    fork: () => { const node = new FakeNode(); nodes.push(node); return node },
    artifact: async () => { calls.artifact += 1; return state.artifact },
    files: [],
    apiPortTaken: () => { portsTaken.push(24_242) },
    now: () => clock.now,
    proxyConfigured: async () => { calls.proxy += 1; if (state.proxy === 'throws') throw new Error('no answer'); return state.proxy },
    disabled: () => state.disabled,
    apiPort: () => 24_242,
    dataDir: () => '/profile/swarm-node',
    componentName: 'swarm-node',
    sleep: async (ms) => await new Promise<void>((wake) => { sleeps.push({ ms, wake }) }),
    setTimer: (run, ms) => { timers.push({ ms, run }) },
    ...(options === undefined ? {} : { options }),
    ...(removed === undefined ? {} : { remove: async (path: string) => { removed.push(path) } }),
    ...extra
  }
  const controller = new LocalNodeController(deps)
  return Object.defineProperties({ controller, nodes, sleeps, timers, calls, portsTaken, clock } as unknown as Harness, {
    artifact: { get: () => state.artifact, set: (value: ArtifactStatus) => { state.artifact = value } },
    proxy: { get: () => state.proxy, set: (value: boolean | 'throws') => { state.proxy = value } },
    disabled: { get: () => state.disabled, set: (value: string | undefined) => { state.disabled = value } }
  })
}

const settle = async (): Promise<void> => { await new Promise((resolve) => setImmediate(resolve)) }

/** Time passes for the fake timers and for the clock the controller reads. */
async function tick (h: Harness, ms: number): Promise<void> {
  h.clock.now += ms
  await vi.advanceTimersByTimeAsync(ms)
}

afterEach(() => { vi.useRealTimers() })

describe('forgetting what a node kept', () => {
  it('stops the node, waits for its process to exit, and only then deletes the files from its data directory', async () => {
    const removed: string[] = []
    const h = harness(undefined, removed)
    const asked = h.controller.ensure()
    await settle()
    h.nodes[0]?.say({ type: 'ready', peers: 0 })
    await asked
    const forgetting = h.controller.forget(['blocks.db', 'blocks.db-wal'])
    await settle()
    expect(h.nodes[0]?.killed).toBe(true)
    expect(removed).toEqual([])
    h.nodes[0]?.exit(0)
    await forgetting
    expect(removed).toEqual(['/profile/swarm-node/blocks.db', '/profile/swarm-node/blocks.db-wal'])
    expect(h.controller.state()).toEqual({ state: 'off' })
  })

  it('deletes at once when no node is running, and the next ask starts a new process', async () => {
    const removed: string[] = []
    const h = harness(undefined, removed)
    await h.controller.forget(['blocks.db'])
    expect(removed).toEqual(['/profile/swarm-node/blocks.db'])
    expect(h.nodes).toEqual([])
    void h.controller.ensure()
    await settle()
    expect(h.nodes).toHaveLength(1)
  })
})

describe('what the node resolves names with', () => {
  it('hands the node the DNS-over-HTTPS endpoints it resolves names with first', async () => {
    const h = harness(undefined, undefined, { dohEndpoints: ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'] })
    void h.controller.ensure()
    await settle()
    expect(h.nodes[0]?.sent).toEqual([expect.objectContaining({ type: 'start', config: expect.objectContaining({ dohEndpoints: ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'] }) as unknown })])
  })
})

describe('what the person chose', () => {
  it('reaches the node as options at each start, so a change reaches the next one', async () => {
    let mode = 'auto'
    const h = harness(() => ({ routingMode: mode }))
    void h.controller.ensure()
    await settle()
    expect(h.nodes[0]?.sent).toEqual([expect.objectContaining({ type: 'start', config: expect.objectContaining({ options: { routingMode: 'auto' } }) as unknown })])
    h.controller.verifierIdle()
    h.nodes[0]?.exit(0)
    mode = 'light-dht'
    void h.controller.ensure()
    await settle()
    expect(h.nodes[1]?.sent).toEqual([expect.objectContaining({ config: expect.objectContaining({ options: { routingMode: 'light-dht' } }) as unknown })])
  })
})

describe('a node that must not start', () => {
  it('is off with the reason when its files are missing, and nothing is forked', async () => {
    const h = harness()
    h.artifact = { ok: false, reason: 'the Swarm node is not installed' }
    expect(await h.controller.ensure()).toEqual({ state: 'off', reason: 'the Swarm node is not installed' })
    expect(h.nodes).toEqual([])
  })

  it('is off when a proxy is configured, and also when the proxy check cannot answer', async () => {
    const h = harness()
    h.proxy = true
    expect(await h.controller.ensure()).toEqual({ state: 'off', reason: PROXY_REASON })
    h.proxy = 'throws'
    expect(await h.controller.ensure()).toEqual({ state: 'off', reason: PROXY_REASON })
    expect(h.nodes).toEqual([])
  })

  it('says the tunnel is the reason when the whole browser is on it, because the node dials its peers itself', async () => {
    const h = harness(undefined, undefined, { tunnelOn: () => true })
    h.proxy = true
    const state = await h.controller.ensure()
    expect(state).toEqual({ state: 'off', reason: proxyReason(SWARM_NODE_IDENTITY, true) })
    expect(proxyReason(SWARM_NODE_IDENTITY, true)).toMatch(/goes through the tunnel/)
    expect(h.nodes).toEqual([])
  })

  it('is off in a build that serves Swarm from its own endpoints', async () => {
    const h = harness()
    h.disabled = 'a test build serves Swarm from its own endpoints'
    expect(await h.controller.ensure()).toEqual({ state: 'off', reason: 'a test build serves Swarm from its own endpoints' })
    expect(h.nodes).toEqual([])
  })

  it('starts once the obstacle is gone', async () => {
    const h = harness()
    h.proxy = true
    await h.controller.ensure()
    h.proxy = false
    h.clock.now += REFUSAL_MEMORY_MS
    const pending = h.controller.ensure()
    await settle()
    expect(h.nodes).toHaveLength(1)
    h.nodes[0]?.say({ type: 'ready', peers: 9 })
    expect((await pending).state).toBe('ready')
  })
})

describe('on demand', () => {
  it('is off until something asks, then forks once and hands the process its config', async () => {
    const h = harness()
    expect(h.controller.state()).toEqual({ state: 'off' })
    expect(h.nodes).toEqual([])
    const first = h.controller.ensure()
    const second = h.controller.ensure()
    await settle()
    expect(h.nodes).toHaveLength(1)
    expect(h.nodes[0]?.sent).toEqual([{ type: 'start', config: { kind: 'swarm-node', apiPort: 24_242, dataDir: '/profile/swarm-node', componentDir: '/artifact', componentName: 'swarm-node', files: [] } satisfies LocalNodeConfig }])
    expect(h.controller.state()).toEqual({ state: 'starting' })
    h.nodes[0]?.say({ type: 'ready', peers: 8 })
    expect(await first).toEqual({ state: 'ready', peers: 8 })
    expect(await second).toEqual({ state: 'ready', peers: 8 })
  })

  it('answers at once when the node is ready', async () => {
    const h = harness()
    const first = h.controller.ensure()
    await settle()
    h.nodes[0]?.say({ type: 'ready', peers: 12 })
    await first
    expect(await h.controller.ensure()).toEqual({ state: 'ready', peers: 12 })
    expect(h.sleeps).toHaveLength(1)
    expect(h.nodes).toHaveLength(1)
  })

  it('answers that the node is still starting once the wait is over', async () => {
    const h = harness()
    const asked = h.controller.ensure()
    await settle()
    h.nodes[0]?.say({ type: 'peers', count: 3 })
    expect(h.sleeps.map((entry) => entry.ms)).toEqual([READY_WAIT_MS])
    h.sleeps[0]?.wake()
    expect(await asked).toEqual({ state: 'starting', peers: 3 })
  })

  it('follows the peer count while ready', async () => {
    const h = harness()
    const changes: string[] = []
    h.controller.onChange(() => { changes.push(JSON.stringify(h.controller.state())) })
    const asked = h.controller.ensure()
    await settle()
    h.nodes[0]?.say({ type: 'listening' })
    h.nodes[0]?.say({ type: 'peers', count: 2 })
    h.nodes[0]?.say({ type: 'ready', peers: 8 })
    h.nodes[0]?.say({ type: 'peers', count: 30 })
    await asked
    expect(changes).toEqual([
      '{"state":"starting"}', '{"state":"starting","peers":2}', '{"state":"ready","peers":8}', '{"state":"ready","peers":30}'
    ])
  })

  it('drops a message that is not one the node may post', async () => {
    const h = harness()
    const asked = h.controller.ensure()
    await settle()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.nodes[0]?.say({ type: 'ready', peers: -1 })
    h.nodes[0]?.say({ type: 'failed', stage: 'elsewhere', message: 'x' })
    h.nodes[0]?.say({ type: 'rm -rf' })
    errors.mockRestore()
    expect(h.controller.state()).toEqual({ state: 'starting' })
    h.sleeps[0]?.wake()
    await asked
  })
})

describe('when the node fails', () => {
  it('kills a node that says it cannot run, names why, and answers failed', async () => {
    const h = harness()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const asked = h.controller.ensure()
    await settle()
    h.nodes[0]?.say({ type: 'failed', stage: 'compile', message: 'bad module' })
    expect(await asked).toEqual({ state: 'failed', reason: 'the Swarm node could not run (compile): bad module' })
    expect(h.nodes[0]?.killed).toBe(true)
    expect(await h.controller.ensure()).toMatchObject({ state: 'failed' })
    errors.mockRestore()
  })

  it('restarts a node that exits, on the supervisor\'s backoff, and is starting again then', async () => {
    const h = harness()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const asked = h.controller.ensure()
    await settle()
    h.nodes[0]?.exit(1)
    expect((await asked).state).toBe('failed')
    expect(h.timers.map((entry) => entry.ms)).toEqual([1000])
    h.timers[0]?.run()
    await settle()
    expect(h.nodes).toHaveLength(2)
    expect(h.controller.state()).toEqual({ state: 'starting' })
    errors.mockRestore()
  })

  it('checks the files and the proxy again at a restart, and fails with the reason', async () => {
    const h = harness()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const asked = h.controller.ensure()
    await settle()
    h.nodes[0]?.say({ type: 'ready', peers: 8 })
    await asked
    h.nodes[0]?.exit(1)
    h.artifact = { ok: false, reason: 'the Swarm node\'s file x is not the one this build pins' }
    h.timers[0]?.run()
    await settle()
    expect(h.controller.state()).toEqual({ state: 'off', reason: expect.stringContaining('not the one this build pins') as string })
    expect(h.nodes[1]?.killed).toBe(true)
    // A refusal is final until it is asked for again: no second restart is queued.
    h.nodes[1]?.exit(0)
    expect(h.timers).toHaveLength(1)
    errors.mockRestore()
  })
})

describe('sleeping', () => {
  it('sleeps when the verifier host does, and starts a fresh node on the next ask', async () => {
    const h = harness()
    const asked = h.controller.ensure()
    await settle()
    h.nodes[0]?.say({ type: 'ready', peers: 8 })
    await asked
    h.controller.verifierIdle()
    expect(h.nodes[0]?.killed).toBe(true)
    expect(h.controller.state()).toEqual({ state: 'off' })
    const again = h.controller.ensure()
    await settle()
    h.nodes[0]?.exit(0)
    await settle()
    expect(h.nodes).toHaveLength(2)
    h.nodes[1]?.say({ type: 'ready', peers: 8 })
    expect((await again).state).toBe('ready')
  })

  it('sleeps after ten minutes with no ask, and an ask restarts the wait', async () => {
    vi.useFakeTimers()
    const h = harness()
    const asked = h.controller.ensure()
    await vi.advanceTimersByTimeAsync(0)
    h.nodes[0]?.say({ type: 'ready', peers: 8 })
    await asked
    await tick(h, 6 * 60_000)
    void h.controller.ensure()
    await tick(h, 6 * 60_000)
    expect(h.nodes[0]?.killed).toBe(false)
    await tick(h, 6 * 60_000)
    expect(h.nodes[0]?.killed).toBe(true)
    expect(h.controller.state()).toEqual({ state: 'off' })
    h.controller.stop()
  })

  it('stops for good at quit', async () => {
    const h = harness()
    const asked = h.controller.ensure()
    await settle()
    h.nodes[0]?.say({ type: 'ready', peers: 8 })
    await asked
    h.controller.stop()
    expect(h.nodes[0]?.killed).toBe(true)
    h.nodes[0]?.exit(0)
    void h.controller.ensure()
    await settle()
    expect(h.nodes).toHaveLength(1)
  })
})

describe('keeping a node that is in use', () => {
  it('stays up past the idle window while asks keep arriving every few seconds, and goes once they stop', async () => {
    vi.useFakeTimers()
    const h = harness()
    const first = h.controller.ensure()
    await vi.advanceTimersByTimeAsync(0)
    h.nodes[0]?.say({ type: 'ready', peers: 8 })
    await first
    // A page reading chunks asks every few seconds, for 25 minutes.
    for (let seconds = 0; seconds < 25 * 60; seconds += 5) {
      await tick(h, 5_000)
      void h.controller.ensure()
    }
    expect(h.nodes[0]?.killed).toBe(false)
    expect(h.nodes).toHaveLength(1)
    await tick(h, 11 * 60_000)
    expect(h.nodes[0]?.killed).toBe(true)
    h.controller.stop()
  })
})

describe('a start that cannot succeed', () => {
  it.each(['artifact', 'compile'] as const)('is not tried again on a backoff after a %s failure, and is answered from memory until it fades', async (stage) => {
    const h = harness()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const asked = h.controller.ensure()
    await settle()
    h.nodes[0]?.say({ type: 'failed', stage, message: 'bad module' })
    h.nodes[0]?.exit(1)
    expect((await asked).state).toBe('failed')
    expect(h.timers).toEqual([])
    const checks = { ...h.calls }
    expect(await h.controller.ensure()).toMatchObject({ state: 'failed' })
    expect(h.calls).toEqual(checks)
    expect(h.nodes).toHaveLength(1)
    h.clock.now += REFUSAL_MEMORY_MS
    const again = h.controller.ensure()
    await settle()
    expect(h.nodes).toHaveLength(2)
    h.nodes[1]?.say({ type: 'ready', peers: 8 })
    expect((await again).state).toBe('ready')
    errors.mockRestore()
  })

  it('asks the owner for another port when the node could not bind its own, and tries again at once', async () => {
    const h = harness()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const asked = h.controller.ensure()
    await settle()
    h.nodes[0]?.say({ type: 'failed', stage: 'port', message: 'its API port 24242 is taken by another program' })
    h.nodes[0]?.exit(1)
    expect((await asked).state).toBe('failed')
    expect(h.portsTaken).toHaveLength(1)
    expect(h.timers).toEqual([])
    const again = h.controller.ensure()
    await settle()
    expect(h.nodes).toHaveLength(2)
    h.nodes[1]?.say({ type: 'ready', peers: 8 })
    await again
    errors.mockRestore()
  })

  it('is refused for a proxy before any file is read', async () => {
    const h = harness()
    h.proxy = true
    expect(await h.controller.ensure()).toEqual({ state: 'off', reason: PROXY_REASON })
    expect(h.calls).toEqual({ artifact: 0, proxy: 1 })
  })

  it('answers a refusal from memory for a while, then looks again', async () => {
    const h = harness()
    h.artifact = { ok: false, reason: 'the Swarm node is not installed' }
    await h.controller.ensure()
    await h.controller.ensure()
    await h.controller.ensure()
    expect(h.calls).toEqual({ artifact: 1, proxy: 1 })
    h.clock.now += REFUSAL_MEMORY_MS
    h.artifact = { ok: true, directory: '/artifact' }
    const asked = h.controller.ensure()
    await settle()
    expect(h.nodes).toHaveLength(1)
    h.nodes[0]?.say({ type: 'ready', peers: 8 })
    expect((await asked).state).toBe('ready')
  })
})

describe('what a start costs', () => {
  it('hashes the files once for a start, however many asks come at once', async () => {
    const h = harness()
    const asks = [h.controller.ensure(), h.controller.ensure(), h.controller.ensure()]
    await settle()
    expect(h.calls.artifact).toBe(1)
    expect(h.nodes).toHaveLength(1)
    h.nodes[0]?.say({ type: 'ready', peers: 8 })
    await Promise.all(asks)
    await h.controller.ensure()
    expect(h.calls.artifact).toBe(1)
  })

  it('checks again for a restart on the backoff, once', async () => {
    const h = harness()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const asked = h.controller.ensure()
    await settle()
    h.nodes[0]?.say({ type: 'ready', peers: 8 })
    await asked
    h.nodes[0]?.exit(139)
    expect(h.calls.artifact).toBe(1)
    await h.controller.ensure()
    expect(h.calls.artifact).toBe(1)
    h.timers[0]?.run()
    await settle()
    expect(h.calls.artifact).toBe(2)
    errors.mockRestore()
  })
})

describe('the person switching the node off and on', () => {
  it('stops a running node and says why it is off, and refuses the next ask in the same words', async () => {
    const h = harness()
    const asked = h.controller.ensure()
    await settle()
    h.nodes[0]?.say({ type: 'ready', peers: 3 })
    await asked
    h.disabled = 'Swarm is switched off'
    h.controller.reconsider()
    expect(h.nodes[0]?.killed).toBe(true)
    expect(h.controller.state()).toEqual({ state: 'off', reason: 'Swarm is switched off' })
    expect(await h.controller.ensure()).toEqual({ state: 'off', reason: 'Swarm is switched off' })
    expect(h.nodes).toHaveLength(1)
  })

  it('lets the next ask start it as soon as it is switched back on, without waiting out the memory of the refusal', async () => {
    const h = harness()
    h.disabled = 'Swarm is switched off'
    await h.controller.ensure()
    h.disabled = undefined
    h.controller.reconsider()
    expect(h.controller.state()).toEqual({ state: 'off' })
    void h.controller.ensure()
    await settle()
    expect(h.nodes).toHaveLength(1)
  })

  it('names the process while it runs, with when it was forked', async () => {
    const h = harness()
    expect(h.controller.processInfo()).toBeUndefined()
    void h.controller.ensure()
    await settle()
    expect(h.controller.processInfo()).toEqual({ pid: undefined, startedAt: 1_000_000 })
  })
})
