import { describe, expect, it, vi } from 'vitest'
import type { LocalNodeSubsystem } from '../local-node-subsystem.js'
import { followNodes, noticeOf } from '../node-notices.js'

// What the verifier host is told of a local node, and when.

type State = ReturnType<LocalNodeSubsystem['state']>

function fakeNode (initial: State): { node: LocalNodeSubsystem, set: (state: State) => void, changed: () => void, moved: () => void } {
  let state = initial
  const onChange = new Set<() => void>()
  const onEndpoint = new Set<() => void>()
  const node = {
    state: () => state,
    onChange: (listener: () => void) => { onChange.add(listener); return () => { onChange.delete(listener) } },
    onEndpointChange: (listener: () => void) => { onEndpoint.add(listener); return () => { onEndpoint.delete(listener) } }
  } as unknown as LocalNodeSubsystem
  return { node, set: (next) => { state = next }, changed: () => { for (const listener of onChange) listener() }, moved: () => { for (const listener of onEndpoint) listener() } }
}

describe('noticeOf', () => {
  it('names the node and its state', () => {
    expect(noticeOf('ipfs', { state: () => ({ state: 'ready', peers: 3 }) })).toEqual({ type: 'node', node: 'ipfs', state: 'ready' })
  })

  it('carries the reason of a node that is off or has failed, and only then', () => {
    expect(noticeOf('swarm', { state: () => ({ state: 'off', reason: 'switched off' }) })).toEqual({ type: 'node', node: 'swarm', state: 'off', reason: 'switched off' })
    expect(noticeOf('swarm', { state: () => ({ state: 'failed', reason: 'port taken' }) })).toEqual({ type: 'node', node: 'swarm', state: 'failed', reason: 'port taken' })
    expect(noticeOf('swarm', { state: () => ({ state: 'off' }) })).toEqual({ type: 'node', node: 'swarm', state: 'off' })
  })
})

describe('followNodes', () => {
  it('tells the host the new state on every change, and lets the shell know', () => {
    const swarm = fakeNode({ state: 'off' })
    const host = { send: vi.fn(), idle: vi.fn() }
    const changed = vi.fn()
    followNodes(new Map([['swarm', swarm.node]]), host, changed)
    swarm.set({ state: 'failed', reason: 'port taken' })
    swarm.changed()
    expect(host.send).toHaveBeenCalledWith({ type: 'node', node: 'swarm', state: 'failed', reason: 'port taken' })
    expect(changed).toHaveBeenCalledTimes(1)
    expect(host.idle).not.toHaveBeenCalled()
  })

  it('puts the host to sleep when a node\'s endpoint moves, without a notice', () => {
    const ipfs = fakeNode({ state: 'off' })
    const host = { send: vi.fn(), idle: vi.fn() }
    followNodes(new Map([['ipfs', ipfs.node]]), host, vi.fn())
    ipfs.moved()
    expect(host.idle).toHaveBeenCalledTimes(1)
    expect(host.send).not.toHaveBeenCalled()
  })
})
