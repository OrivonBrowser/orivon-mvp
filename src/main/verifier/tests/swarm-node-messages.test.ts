import { describe, expect, it } from 'vitest'
import { isFromNode, isSwarmNodeWanted } from '../host-messages.js'
import { swarmNodeView } from '../status-view.js'
import { QUIET_PORTS, loopbackPort, swarmNodePort } from '../loopback-port.js'

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

describe('isSwarmNodeWanted', () => {
  it('accepts only the verifier host\'s ask', () => {
    expect(isSwarmNodeWanted({ type: 'swarm-node-wanted' })).toBe(true)
    expect(isSwarmNodeWanted({ type: 'ready', peers: 8 })).toBe(false)
    expect(isSwarmNodeWanted(null)).toBe(false)
    expect(isSwarmNodeWanted('swarm-node-wanted')).toBe(false)
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
