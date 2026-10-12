import { describe, expect, it } from 'vitest'
import { MAX_FAILURE_MESSAGE, failure } from '../../../protocols/swarm-node/protocol.js'
import { isFromHost, isFromNode } from '../host-messages.js'
import { swarmNodeView } from '../status-view.js'
import { QUIET_PORTS, loopbackPort, swarmNodePort } from '../loopback-port.js'

describe('isFromNode, for a failure message', () => {
  it('accepts one of the longest length the node sends, and refuses a longer one', () => {
    expect(isFromNode({ type: 'failed', stage: 'run', message: 'x'.repeat(MAX_FAILURE_MESSAGE) })).toBe(true)
    expect(isFromNode({ type: 'failed', stage: 'run', message: 'x'.repeat(MAX_FAILURE_MESSAGE + 1) })).toBe(false)
  })

  it('accepts the port stage', () => {
    expect(isFromNode({ type: 'failed', stage: 'port', message: 'its API port 1 is taken by another program' })).toBe(true)
  })
})

describe('isFromNode', () => {
  it.each([
    { type: 'listening' }, { type: 'peers', count: 0 }, { type: 'peers', count: 120 }, { type: 'ready', peers: 8 },
    { type: 'failed', stage: 'artifact', message: 'x' }, { type: 'failed', stage: 'compile', message: '' }, { type: 'failed', stage: 'start', message: 'x' }, { type: 'failed', stage: 'run', message: 'x' }
  ])('accepts %j', (message) => {
    expect(isFromNode(message)).toBe(true)
  })

  it.each([
    null, undefined, 'ready', 7, [], {}, { type: 'unknown' }, { type: 'peers' }, { type: 'peers', count: -1 }, { type: 'peers', count: 1.5 }, { type: 'peers', count: '3' },
    { type: 'ready' }, { type: 'ready', peers: Number.NaN }, { type: 'failed' }, { type: 'failed', stage: 'elsewhere', message: 'x' }, { type: 'failed', stage: 'run' }, { type: 'failed', stage: 'run', message: 5 },
    { type: 'reply', id: 1, ok: true, value: 1 }, { type: 'swarm-node-wanted' }
  ])('refuses %j', (message) => {
    expect(isFromNode(message)).toBe(false)
  })
})

describe('failure', () => {
  it('cuts a text to what main accepts, keeping a short one as it is', () => {
    expect(isFromNode(failure('run', 'y'.repeat(100_000)))).toBe(true)
    expect(failure('run', 'short')).toEqual({ type: 'failed', stage: 'run', message: 'short' })
  })
})

describe('the verifier host asking for the Swarm node', () => {
  it('is a message the host may post, and nothing the node may', () => {
    expect(isFromHost({ type: 'swarm-node-wanted' })).toBe(true)
    expect(isFromNode({ type: 'swarm-node-wanted' })).toBe(false)
  })
})

describe('swarmNodeView', () => {
  it('says what each state means in words', () => {
    expect(swarmNodeView({ state: 'off' })).toEqual({ state: 'off', summary: expect.stringContaining('starts when a Swarm address is opened') as string })
    expect(swarmNodeView({ state: 'off', reason: 'a proxy is configured' })).toEqual({ state: 'off', summary: 'Off: a proxy is configured.' })
    expect(swarmNodeView({ state: 'starting' }).summary).toBe('Starting, and finding peers.')
    expect(swarmNodeView({ state: 'starting', peers: 0 }).summary).toBe('Starting, and finding peers.')
    expect(swarmNodeView({ state: 'starting', peers: 1 }).summary).toBe('Starting: 1 peer found so far.')
    expect(swarmNodeView({ state: 'starting', peers: 5 }).summary).toBe('Starting: 5 peers found so far.')
    expect(swarmNodeView({ state: 'ready', peers: 27 })).toEqual({ state: 'ready', summary: 'Running, with 27 peers.' })
    expect(swarmNodeView({ state: 'failed', reason: 'it trapped' })).toEqual({ state: 'failed', summary: 'Not running: it trapped. It tries again shortly.' })
  })
})

describe('swarmNodePort', () => {
  it('is a quiet port of its own, the same every time', () => {
    const port = swarmNodePort()
    expect(port).not.toBe(loopbackPort())
    expect(port).toBeGreaterThanOrEqual(QUIET_PORTS.first)
    expect(port).toBeLessThanOrEqual(QUIET_PORTS.last)
    expect(swarmNodePort()).toBe(port)
  })
})

describe('the light client view with a Swarm node', () => {
  const facts = { lightClient: { state: 'off' as const }, checkpoint: undefined, hostDown: undefined, hostAsleep: true, switchedOff: true, endpoints: { executionRpcs: [], consensusRpc: '', gateways: [], swarmEndpoints: ['http://127.0.0.1:24242'], ipnsNameServices: [], dnsOverHttps: [] } }

  it('carries the node\'s state in words when a run uses the node, and nothing when it does not', async () => {
    const { lightClientView } = await import('../status-view.js')
    expect(lightClientView({ ...facts, swarmNode: { state: 'ready', peers: 12 } }, 0).swarmNode).toEqual({ state: 'ready', summary: 'Running, with 12 peers.' })
    expect(lightClientView(facts, 0)).not.toHaveProperty('swarmNode')
  })
})
