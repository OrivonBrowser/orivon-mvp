// trust.websiteScore's control-channel wiring: the payload check, the grant check that comes before any
// lookup, and what the lookup's answer and refusals look like across the channel. The lookup itself is
// src/main/browsing/tests/page-score-lookup.test.ts's job; the grant against a real broker is
// ../../tests/trust-capability.test.ts's.

import { describe, expect, it } from 'vitest'
import { fail } from '../../errors.js'
import { handleControlRequest } from '../ipc.js'
import type { BrokerCall } from './ipc.test-helpers.js'
import { APP, envelope, frameFor, stubBroker } from './ipc.test-helpers.js'

const GRANTED = { trustRequireScoreGrant: () => {} }
const REFUSED = { trustRequireScoreGrant: () => { throw fail('denied', 'trust.score is not granted to this origin') } }

describe('trust.websiteScore', () => {
  it('asks the lookup with the sender-frame origin and the address, once the grant holds', async () => {
    const calls: BrokerCall[] = []
    const asked: Array<[string, string]> = []
    const ctx = {
      requestGrant: undefined,
      websiteScore: async (origin: string, address: string) => { asked.push([origin, address]); return { provider: 'P', level: 3 as const } }
    }
    const response = await handleControlRequest(stubBroker(calls, GRANTED), frameFor(APP), envelope('trust.websiteScore', { address: 'ipfs://bafy' }), undefined, undefined, ctx)

    expect(response).toEqual({ id: 'req-1', ok: true, result: { provider: 'P', level: 3 } })
    expect(asked).toEqual([[APP, 'ipfs://bafy']])
    expect(calls).toEqual([{ method: 'trust.requireScoreGrant', origin: APP, args: undefined }])
  })

  it('refuses denied without a grant, and never reaches the lookup', async () => {
    const asked: string[] = []
    const ctx = { requestGrant: undefined, websiteScore: async (_origin: string, address: string) => { asked.push(address); return { provider: null, level: null } } }
    const response = await handleControlRequest(stubBroker([], REFUSED), frameFor(APP), envelope('trust.websiteScore', { address: 'scored.eth' }), undefined, undefined, ctx)

    expect(response).toEqual({ id: 'req-1', ok: false, code: 'denied', message: expect.any(String) })
    expect(asked).toEqual([])
  })

  it('rejects a payload whose address is not a string as invalid, before the grant is read', async () => {
    const calls: BrokerCall[] = []
    for (const payload of [{}, { address: 42 }, { address: null }, null, 'ipfs://x']) {
      const response = await handleControlRequest(stubBroker(calls, GRANTED), frameFor(APP), envelope('trust.websiteScore', payload))
      expect(response).toEqual({ id: 'req-1', ok: false, code: 'invalid', message: expect.any(String) })
    }
    expect(calls).toEqual([])
  })

  it('fails internal when the lookup was never wired, instead of answering for it', async () => {
    const response = await handleControlRequest(stubBroker([], GRANTED), frameFor(APP), envelope('trust.websiteScore', { address: 'scored.eth' }), undefined, undefined, { requestGrant: undefined })
    expect(response).toMatchObject({ ok: false, code: 'internal' })
  })

  it('crosses the lookup\'s limit refusal as the closed code', async () => {
    const ctx = { requestGrant: undefined, websiteScore: async () => { throw fail('limit', 'too frequent') } }
    const response = await handleControlRequest(stubBroker([], GRANTED), frameFor(APP), envelope('trust.websiteScore', { address: 'scored.eth' }), undefined, undefined, ctx)
    expect(response).toEqual({ id: 'req-1', ok: false, code: 'limit', message: 'too frequent' })
  })

  it('is not an unknown method: the exhaustive switch routes it', async () => {
    const response = await handleControlRequest(stubBroker([], GRANTED), frameFor(APP), envelope('trust.nope', { address: 'a' }))
    expect(response).toMatchObject({ ok: false, code: 'invalid' })
  })
})
