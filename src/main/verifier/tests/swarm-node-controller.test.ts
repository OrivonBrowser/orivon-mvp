import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FromNode, SwarmNodeConfig } from '../../../protocols/swarm-node/protocol.js'
import type { HostProcess } from '../process-supervisor.js'
import type { ArtifactStatus } from '../swarm-node-artifact.js'
import { PROXY_REASON, READY_WAIT_MS, SwarmNodeController } from '../swarm-node-controller.js'
import type { ControllerDeps } from '../swarm-node-controller.js'

class FakeNode extends EventEmitter implements HostProcess {
  readonly sent: unknown[] = []
  killed = false
  postMessage (message: unknown): void { this.sent.push(message) }
  kill (): boolean { this.killed = true; return true }
  say (message: unknown): void { this.emit('message', message) }
  exit (code = 0): void { this.emit('exit', code) }
}

interface Harness {
  readonly controller: SwarmNodeController
  readonly nodes: FakeNode[]
  readonly sleeps: Array<{ ms: number, wake: () => void }>
  readonly timers: Array<{ ms: number, run: () => void }>
  artifact: ArtifactStatus
  proxy: boolean | 'throws'
  disabled: string | undefined
}

function harness (): Harness {
  const nodes: FakeNode[] = []
  const sleeps: Harness['sleeps'] = []
  const timers: Harness['timers'] = []
  const state = { artifact: { ok: true, directory: '/artifact' } as ArtifactStatus, proxy: false as boolean | 'throws', disabled: undefined as string | undefined }
  const deps: ControllerDeps = {
    fork: () => { const node = new FakeNode(); nodes.push(node); return node },
    artifact: async () => state.artifact,
    proxyConfigured: async () => { if (state.proxy === 'throws') throw new Error('no answer'); return state.proxy },
    disabled: () => state.disabled,
    apiPort: () => 24_242,
    dataDir: () => '/profile/swarm-node',
    componentName: 'swarm-node',
    sleep: async (ms) => await new Promise<void>((wake) => { sleeps.push({ ms, wake }) }),
    setTimer: (run, ms) => { timers.push({ ms, run }) }
  }
  const controller = new SwarmNodeController(deps)
  return Object.defineProperties({ controller, nodes, sleeps, timers } as unknown as Harness, {
    artifact: { get: () => state.artifact, set: (value: ArtifactStatus) => { state.artifact = value } },
    proxy: { get: () => state.proxy, set: (value: boolean | 'throws') => { state.proxy = value } },
    disabled: { get: () => state.disabled, set: (value: string | undefined) => { state.disabled = value } }
  })
}

const settle = async (): Promise<void> => { await new Promise((resolve) => setImmediate(resolve)) }

afterEach(() => { vi.useRealTimers() })

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
    expect(h.nodes[0]?.sent).toEqual([{ type: 'start', config: { apiPort: 24_242, dataDir: '/profile/swarm-node', componentDir: '/artifact', componentName: 'swarm-node' } satisfies SwarmNodeConfig }])
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
    expect(h.controller.state()).toEqual({ state: 'failed', reason: expect.stringContaining('not the one this build pins') as string })
    expect(h.nodes[1]?.killed).toBe(true)
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
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    void h.controller.ensure()
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    expect(h.nodes[0]?.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(6 * 60_000)
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
