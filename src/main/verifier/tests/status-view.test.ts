import { describe, expect, it } from 'vitest'
import { lightClientView } from '../status-view.js'
import type { VerifierFacts } from '../status-view.js'

const NOW = 1_790_000_000_000
const ENDPOINTS = { executionRpcs: ['https://a.rpc', 'https://b.rpc'], consensusRpc: 'https://beacon', gateways: ['https://gw'] }
const ROOT = '0x' + 'a'.repeat(64)

function facts (overrides: Partial<VerifierFacts>): VerifierFacts {
  return { lightClient: { state: 'starting' }, checkpoint: { ok: true, checkpoint: { root: ROOT, timestamp: 0 }, source: 'this-install', ageSeconds: 3 * 3600 }, hostDown: undefined, switchedOff: false, endpoints: ENDPOINTS, ...overrides }
}

describe('lightClientView', () => {
  it('says the block it follows and when it last checked', () => {
    const view = lightClientView(facts({ lightClient: { state: 'synced', block: 26_047_527, at: NOW - 2 * 60_000 } }), NOW)
    expect(view.state).toBe('synced')
    expect(view.summary).toBe('Following the chain: block 26,047,527, checked 2 minutes ago.')
    expect(view.checkpoint).toBe('Checkpoint 3 hours old, last verified on this computer.')
  })

  it('says why it failed and when it tries again', () => {
    const view = lightClientView(facts({ lightClient: { state: 'failed', reason: 'could not fetch bootstrap', retryAt: NOW + 5_000 } }), NOW)
    expect(view.summary).toBe('Failed: could not fetch bootstrap. Trying again in 5 s.')
  })

  it('says it is switched off, whatever the last state reported', () => {
    expect(lightClientView(facts({ switchedOff: true, lightClient: { state: 'synced', block: 1, at: NOW } }), NOW)).toMatchObject({ state: 'off' })
  })

  it('says the verifier is down before anything else, switched off or not', () => {
    for (const switchedOff of [false, true]) {
      expect(lightClientView(facts({ switchedOff, hostDown: 'the verifier host exited with code 1', lightClient: { state: 'synced', block: 1, at: NOW } }), NOW))
        .toMatchObject({ state: 'down', summary: 'The verifier is not running: the verifier host exited with code 1.' })
    }
  })

  it('names a stale checkpoint and what fixes it', () => {
    const view = lightClientView(facts({ checkpoint: { ok: false, reason: 'the newest checkpoint is 20.0 days old' } }), NOW)
    expect(view.state).toBe('failed')
    expect(view.checkpoint).toBe('No usable checkpoint: the newest checkpoint is 20.0 days old.')
  })

  it('lists every endpoint it contacts, by what each is for', () => {
    expect(lightClientView(facts({}), NOW).endpoints).toEqual([
      { label: 'Ethereum RPCs', urls: ['https://a.rpc', 'https://b.rpc'] },
      { label: 'Beacon API', urls: ['https://beacon'] },
      { label: 'IPFS gateways', urls: ['https://gw'] }
    ])
  })
})
