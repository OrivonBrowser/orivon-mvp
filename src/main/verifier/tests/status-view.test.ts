import { describe, expect, it } from 'vitest'
import { ipfsNodeView, lightClientLog, lightClientView } from '../status-view.js'
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

  it("says when the light client is allowing for a clock that is behind, and how far", () => {
    const sentence = (clockLeadMs: number): string => lightClientView(facts({ lightClient: { state: 'synced', block: 1, at: NOW + clockLeadMs, clockLeadMs } }), NOW).summary
    expect(sentence(45_000)).toContain("This computer's clock is 45 seconds behind the servers', and the light client allows for it.")
    expect(sentence(5 * 60_000)).toContain('is 5 minutes behind')
    expect(sentence(3 * 3_600_000)).toContain('is 3 hours behind')
    expect(lightClientView(facts({ lightClient: { state: 'synced', block: 1, at: NOW } }), NOW).summary).not.toContain('clock')
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

  it("judges the age of its newest block by the servers' time when the computer's clock is behind", () => {
    const hour = 3_600_000
    const view = lightClientView(facts({ lightClient: { state: 'synced', block: 26_047_527, at: NOW + hour - 10 * 60_000, clockLeadMs: hour } }), NOW)
    expect(view).toMatchObject({ state: 'syncing', summary: 'Behind the chain: the newest block it has verified, 26,047,527, was produced 10 minutes ago.' })
    const fresh = lightClientView(facts({ lightClient: { state: 'synced', block: 1, at: NOW + hour - 2 * 60_000, clockLeadMs: hour } }), NOW)
    expect(fresh.summary).toContain('produced 2 minutes ago.')
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
    expect(view.checkpoint).toMatch(/^No usable checkpoint: the newest checkpoint \(shipped with this release\) is 20 days old, past the 14 days a checkpoint may be\. Opening a \.eth name asks two beacon servers for a fresh one\. Installing a newer release brings one too/)
  })

  it('says why a fresh checkpoint could not be fetched, in Settings and in the summary the site popover shows', () => {
    const stale = { ok: false, problem: 'too-old', source: 'release', ageSeconds: 20 * 86_400 } as const
    const reasons = {
      unreachable: /a beacon server did not answer/,
      malformed: /answer that could not be read/,
      'not-finalized': /not finalized/,
      disagree: /did not give the same answer/,
      future: /dated after this computer's clock, which may be set behind/,
      'too-old': /older than a checkpoint may be, which suggests this computer's clock is ahead/,
      'too-few-servers': /fewer than two/,
      'no-bootstrap': /would not start the light client from any recent finalized block/
    } as const
    for (const [problem, pattern] of Object.entries(reasons)) {
      const view = lightClientView(facts({ checkpoint: stale, checkpointFetchProblem: problem as keyof typeof reasons }), NOW)
      expect(view.checkpoint).toMatch(/A fresh one could not be fetched from the beacon servers: /)
      expect(view.checkpoint).toMatch(pattern)
      expect(view.summary).toMatch(/^Not started: it needs a recent checkpoint to start from\. A fresh one could not be fetched: /)
    }
  })

  it('says a checkpoint the beacon server would not start the light client from is not used, and what was tried', () => {
    const view = lightClientView(facts({ checkpoint: { ok: false, problem: 'not-served', source: 'release', ageSeconds: 86_400 }, checkpointFetchProblem: 'unreachable' }), NOW)
    expect(view.state).toBe('failed')
    expect(view.checkpoint).toBe('No usable checkpoint: the beacon server would not start the light client from the newest checkpoint (shipped with this release). A fresh one could not be fetched from the beacon servers: a beacon server did not answer. Installing a newer release brings one too.')
    expect(view.summary).toBe('Not running: the beacon server would not start it from the checkpoint it was given, and no other is at hand. A fresh one could not be fetched: a beacon server did not answer.')
    expect(lightClientView(facts({ checkpoint: { ok: false, problem: 'not-served', source: 'release', ageSeconds: 86_400 } }), NOW).checkpoint).toMatch(/\(shipped with this release\)\. Opening a \.eth name asks two beacon servers for a fresh one\./)
  })

  it('does not call a checkpoint the newest when a newer one was left out for having no bootstrap', () => {
    const view = lightClientView(facts({ checkpoint: { ok: false, problem: 'too-old', source: 'this-install', ageSeconds: 20 * 86_400, skippedUnserved: true } }), NOW)
    expect(view.checkpoint).toMatch(/^No usable checkpoint: a newer checkpoint has no bootstrap on the beacon server, and the newest one it would start from \(last verified on this computer\) is 20 days old, past the 14 days a checkpoint may be\./)
    expect(view.summary).toMatch(/^Not running: the beacon server would not start it/)
  })

  it('leaves the clock case alone: a fetch cannot fix a clock behind the checkpoint', () => {
    const view = lightClientView(facts({ checkpoint: { ok: false, problem: 'clock-behind' }, checkpointFetchProblem: 'disagree' }), NOW)
    expect(view.summary).toBe('Not started: it needs a recent checkpoint to start from.')
    expect(view.checkpoint).not.toMatch(/beacon servers/)
  })

  it('says a fetched checkpoint was fetched at run time, from which servers, and its date', () => {
    const timestamp = Date.UTC(2026, 9, 20, 14, 3) / 1000
    const view = lightClientView(facts({ checkpoint: { ok: true, checkpoint: { root: ROOT, timestamp }, source: 'fetched', ageSeconds: 2 * 3600, fetchedFrom: ['https://ethereum-beacon-api.publicnode.com', 'https://lodestar-mainnet.chainsafe.io'] } }), NOW)
    expect(view.checkpointFetched).toBe(true)
    expect(view.checkpoint).toBe('Checkpoint 2 hours old, dated 2026-10-20 14:03 UTC. It was fetched while a .eth name was opened, because none stored here was recent enough; ethereum-beacon-api.publicnode.com and lodestar-mainnet.chainsafe.io gave the same answer.')
  })

  it('says one hour, not 1 hours', () => {
    const view = lightClientView(facts({ checkpoint: { ok: true, checkpoint: { root: ROOT, timestamp: 1_790_000_000 }, source: 'release', ageSeconds: 3700 } }), NOW)
    expect(view.checkpoint).toBe('Checkpoint 1 hour old, shipped with this release.')
  })

  it('names a fetched checkpoint that has aged out as fetched', () => {
    const view = lightClientView(facts({ checkpoint: { ok: false, problem: 'too-old', source: 'fetched', ageSeconds: 20 * 86_400, fetchedFrom: ['https://a.example'] } }), NOW)
    expect(view.checkpoint).toMatch(/\(fetched from beacon servers\) is 20 days old/)
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

describe('the servers asked for a fresh checkpoint', () => {
  it('are listed with what they are asked for, after the beacon API', () => {
    const view = lightClientView(facts({ endpoints: { ...ENDPOINTS, checkpointBeaconApis: ['https://one', 'https://two'] } }), NOW)
    expect(view.endpoints.map((e) => e.label).slice(0, 3)).toEqual(['Ethereum RPCs', 'Beacon API', 'Beacon servers for a fresh checkpoint, asked only when none is recent enough'])
    expect(view.endpoints[2]?.urls).toEqual(['https://one', 'https://two'])
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

describe('lightClientLog', () => {
  const failed = (reason: string) => ({ state: 'failed' as const, reason, retryAt: NOW })
  const synced = (block: number) => ({ state: 'synced' as const, block, at: NOW })
  const syncing = { state: 'syncing' as const, since: NOW }

  it('logs the first sync once, and none of the refreshes after it', () => {
    const log = lightClientLog()
    expect(log(syncing)).toBeUndefined()
    expect(log(synced(100))).toEqual({ level: 'log', text: 'light client synced at block 100' })
    expect(log(synced(101))).toBeUndefined()
    expect(log(syncing)).toBeUndefined()
    expect(log(synced(102))).toBeUndefined()
  })

  it('logs a failure once across its retries, and again when the reason changes', () => {
    const log = lightClientLog()
    expect(log(failed('it timed out'))).toEqual({ level: 'error', text: 'light client failed: it timed out' })
    expect(log(syncing)).toBeUndefined()
    expect(log(failed('it timed out'))).toBeUndefined()
    expect(log(failed('the beacon API answered 503'))).toEqual({ level: 'error', text: 'light client failed: the beacon API answered 503' })
  })

  it('logs the sync that ends a failure, and the same failure again after it', () => {
    const log = lightClientLog()
    log(synced(100))
    log(failed('it timed out'))
    expect(log(synced(200))).toEqual({ level: 'log', text: 'light client synced at block 200' })
    expect(log(failed('it timed out'))).toEqual({ level: 'error', text: 'light client failed: it timed out' })
  })
})
