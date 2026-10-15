import { describe, expect, it } from 'vitest'
import { ipfsNodeView, lightClientView } from '../status-view.js'
import type { VerifierFacts } from '../status-view.js'

const NOW = 1_790_000_000_000
const ENDPOINTS = { executionRpcs: ['https://a.rpc', 'https://b.rpc'], consensusRpc: 'https://beacon', gateways: ['https://gw'], swarmEndpoints: ['https://bzz'], ipnsNameServices: ['https://names'], dnsOverHttps: ['https://doh'] }
const ROOT = '0x' + 'a'.repeat(64)

function facts (overrides: Partial<VerifierFacts>): VerifierFacts {
  return { lightClient: { state: 'starting' }, checkpoint: { ok: true, checkpoint: { root: ROOT, timestamp: 0 }, source: 'this-install', ageSeconds: 3 * 3600 }, hostDown: undefined, hostAsleep: false, switchedOff: false, endpoints: ENDPOINTS, ...overrides }
}

describe('lightClientView', () => {
  it('says the block it follows and when that block was produced', () => {
    const view = lightClientView(facts({ lightClient: { state: 'synced', block: 26_047_527, at: NOW - 2 * 60_000 } }), NOW)
    expect(view.state).toBe('synced')
    expect(view.summary).toBe('Following the chain: block 26,047,527, produced 2 minutes ago.')
    expect(view.checkpoint).toBe('Checkpoint 3 hours old, last verified on this computer.')
  })

  it('carries the block and when it was produced as numbers, and the age of the checkpoint it starts from, for the Networks popup', () => {
    const view = lightClientView(facts({ lightClient: { state: 'synced', block: 26_047_527, at: NOW - 2 * 60_000 } }), NOW)
    expect(view).toMatchObject({ block: 26_047_527, headAt: NOW - 2 * 60_000, checkpointAgeSeconds: 3 * 3600 })
  })

  it('carries no block while the light client is off, asleep or down, whatever it last reported', () => {
    for (const over of [{ switchedOff: true }, { hostAsleep: true }, { hostDown: 'it exited' }]) {
      expect(lightClientView(facts({ ...over, lightClient: { state: 'synced', block: 1, at: NOW } }), NOW)).not.toHaveProperty('block')
    }
  })

  it('stops saying synced once its newest block is old, whatever it last reported', () => {
    const view = lightClientView(facts({ lightClient: { state: 'synced', block: 26_047_527, at: NOW - 12 * 60_000 } }), NOW)
    expect(view).toMatchObject({ state: 'syncing', summary: 'Behind the chain: the newest block it has verified, 26,047,527, was produced 12 minutes ago.' })
  })

  it('says why it failed and when it tries again', () => {
    const view = lightClientView(facts({ lightClient: { state: 'failed', reason: 'could not fetch bootstrap', retryAt: NOW + 5_000 } }), NOW)
    expect(view.summary).toBe('Failed: could not fetch bootstrap. Trying again in 5 s.')
  })

  it('says it is switched off, whatever the last state reported', () => {
    expect(lightClientView(facts({ switchedOff: true, lightClient: { state: 'synced', block: 1, at: NOW } }), NOW)).toMatchObject({ state: 'off' })
  })

  it('says it is on and waiting, not stopped or failed, while the host sleeps', () => {
    const view = lightClientView(facts({ hostAsleep: true, lightClient: { state: 'off' } }), NOW)
    expect(view.state).toBe('waiting')
    expect(view.summary).toBe('On, and waiting. It starts when a .eth address is opened, and stops again after ten minutes without one.')
    expect(view.summary).not.toMatch(/Not running|not running|Failed/)
  })

  it('still says switched off, a real failure, or a checkpoint too old to start from, while the host sleeps', () => {
    expect(lightClientView(facts({ hostAsleep: true, switchedOff: true }), NOW).summary).toMatch(/^Switched off/)
    expect(lightClientView(facts({ hostAsleep: true, hostDown: 'the verifier host exited with code 1' }), NOW).state).toBe('down')
    expect(lightClientView(facts({ hostAsleep: true, checkpoint: { ok: false, problem: 'too-old', source: 'release', ageSeconds: 20 * 86_400 } }), NOW).state).toBe('failed')
  })

  it('says the verifier is down before anything else, switched off or not', () => {
    for (const switchedOff of [false, true]) {
      expect(lightClientView(facts({ switchedOff, hostDown: 'the verifier host exited with code 1', lightClient: { state: 'synced', block: 1, at: NOW } }), NOW))
        .toMatchObject({ state: 'down', summary: 'The verifier is not running: the verifier host exited with code 1.' })
    }
  })

  it('names a stale checkpoint and what fixes it', () => {
    const view = lightClientView(facts({ checkpoint: { ok: false, problem: 'too-old', source: 'release', ageSeconds: 20 * 86_400 } }), NOW)
    expect(view.state).toBe('failed')
    expect(view.checkpoint).toMatch(/^No usable checkpoint: the newest checkpoint \(shipped with this release\) is 20 days old, past the 14 days a checkpoint may be\. Installing a newer release/)
  })

  it('points at the clock, not a release, when the clock is behind the checkpoint', () => {
    const view = lightClientView(facts({ checkpoint: { ok: false, problem: 'clock-behind' } }), NOW)
    expect(view.checkpoint).toMatch(/clock is behind.*Setting the clock right/)
    expect(view.checkpoint).not.toMatch(/newer release/)
  })

  it('lists every endpoint it contacts, by what each is for', () => {
    expect(lightClientView(facts({}), NOW).endpoints).toEqual([
      { label: 'Ethereum RPCs', urls: ['https://a.rpc', 'https://b.rpc'] },
      { label: 'Beacon API', urls: ['https://beacon'] },
      { label: 'IPFS gateways', urls: ['https://gw'] },
      { label: 'Swarm node, on this computer', urls: ['https://bzz'] },
      { label: 'IPNS name services', urls: ['https://names'] },
      { label: 'DNS-over-HTTPS, for DNSLink', urls: ['https://doh'] }
    ])
  })
})

describe('the IPFS node in the view', () => {
  it('lists the gateways as they were, and no node, while IPFS is read from gateways', () => {
    const view = lightClientView(facts({}), NOW)
    expect(view.ipfsNode).toBeUndefined()
    expect(view.endpoints).toContainEqual({ label: 'IPFS gateways', urls: ['https://gw'] })
  })

  it('lists the node, and the gateways only as what is used while the node cannot run, while IPFS is read from the node', () => {
    const view = lightClientView(facts({ ipfsNode: { state: { state: 'off' }, lookupService: true }, endpoints: { ...ENDPOINTS, ipfsNodeEndpoints: ['http://127.0.0.1:20123'] } }), NOW)
    expect(view.endpoints).toContainEqual({ label: 'IPFS node, on this computer', urls: ['http://127.0.0.1:20123'] })
    expect(view.endpoints).toContainEqual({ label: 'IPFS gateways, only for a site you load through them', urls: ['https://gw'] })
    expect(view.endpoints.map((group) => group.label)).not.toContain('IPFS gateways')
    expect(view.ipfsNode?.state).toBe('off')
  })
})

describe('ipfsNodeView', () => {
  it('says each state in plain words', () => {
    expect(ipfsNodeView({ state: 'off' }, true)).toEqual({ state: 'off', summary: 'Off. It starts when an IPFS address is opened, and stops again after ten minutes without one.' })
    expect(ipfsNodeView({ state: 'starting' }, true).summary).toBe('Starting.')
    expect(ipfsNodeView({ state: 'ready', peers: 0 }, true).summary).toBe('Running, and IPFS content loads from it. It asks its lookup services and the IPFS network.')
    expect(ipfsNodeView({ state: 'ready', peers: 0 }, false).summary).toBe('Running, and IPFS content loads from it. It asks the IPFS network only.')
  })

  it('says why the node is not in use, and that no gateway is used unless the person chooses one', () => {
    const none = 'IPFS pages do not load meanwhile, unless you press "Load through public gateways" on a page\'s error or choose gateways under "Load IPFS sites from"'
    expect(ipfsNodeView({ state: 'off', reason: 'a proxy is configured' }, true).summary).toBe(`Not in use: a proxy is configured. ${none}.`)
    expect(ipfsNodeView({ state: 'failed', reason: 'it trapped' }, true).summary).toBe(`Not running: it trapped. ${none}. The node tries again shortly.`)
  })
})
