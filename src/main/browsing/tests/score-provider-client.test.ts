import { describe, expect, it } from 'vitest'
import { bucketOf, createScoreProviderClient, providerBase } from '../score-provider-client.js'
import type { FetchedJson } from '../score-provider-client.js'
import { SCORE_STANDARD } from '../../../trust/score-provider.js'

const ASGARDEX = 'sha256:26054c511f3394b66c6a022a48d82e559d637ac4b111657482ec6b7a7447fbcf'
const BASE = 'http://127.0.0.1:7860/score'
const DESCRIPTOR = { standard: SCORE_STANDARD, name: 'Test provider', bucketHexChars: 2 }
const EVALUATION = { id: ASGARDEX, name: 'ASGARDEX', evaluated: '2026-10-03', trustlessity: { level: 3 } }

function fakeProvider (files: Record<string, FetchedJson>): { fetchJson: (url: string) => Promise<FetchedJson>, asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    fetchJson: async (url) => {
      asked.push(url)
      return files[url] ?? { kind: 'missing' }
    }
  }
}

function client (files: Record<string, FetchedJson>, address = BASE, clock = { t: 0 }): { verdictFor: (id: string) => Promise<unknown>, asked: string[] } {
  const provider = fakeProvider(files)
  const { verdictFor } = createScoreProviderClient({ providerAddress: () => address, isDevEthName: () => false, fetchJson: provider.fetchJson, now: () => clock.t })
  return { verdictFor, asked: provider.asked }
}

const ok = (body: unknown): FetchedJson => ({ kind: 'ok', body })
const withAsgardex: Record<string, FetchedJson> = {
  [`${BASE}/provider.json`]: ok(DESCRIPTOR),
  [`${BASE}/website/4c.json`]: ok({ standard: SCORE_STANDARD, subject: 'website', bucket: '4c', entries: [EVALUATION] })
}

describe('bucketOf', () => {
  it('matches the test vectors the standard publishes', () => {
    expect(bucketOf(ASGARDEX, 8)).toBe('4c965259')
    expect(bucketOf('sha256:b6761c9738dab8dae6c3ac00c9d048e26992ebbd5f095601f1b8e4782ee24cb2', 8)).toBe('daf1e649')
    expect(bucketOf('cid:bafybeieqer67ojhi6q3eiatmrcu3r3mqjehn7hwit2satqjfnljo65fb4q', 2)).toBe('c6')
  })
})

describe('providerBase', () => {
  const noDev = (): boolean => false

  it('resolves an address the way the address bar does, for every protocol it opens', () => {
    expect(providerBase('http://127.0.0.1:7860/score/', noDev)).toBe(BASE)
    expect(providerBase('127.0.0.1:7860/score', noDev)).toBe(BASE)
    expect(providerBase('https://scores.example/score?x=1#top', noDev)).toBe('https://scores.example/score')
    expect(providerBase('scores.eth/score', noDev)).toBe('https://scores.eth/score')
    expect(providerBase('scores.eth', (host) => host === 'scores.eth')).toBe('http://scores.eth')
    expect(providerBase('ipfs://bafybeieqer67ojhi6q3eiatmrcu3r3mqjehn7hwit2satqjfnljo65fb4q/score', noDev))
      .toBe('https://ipfs.orivon/bafybeieqer67ojhi6q3eiatmrcu3r3mqjehn7hwit2satqjfnljo65fb4q/score')
  })

  it('refuses text the address bar would search for, or a scheme it would never load', () => {
    expect(providerBase('my provider', noDev)).toBeUndefined()
    expect(providerBase('javascript:alert(1)', noDev)).toBeUndefined()
    expect(providerBase('file:///etc/score', noDev)).toBeUndefined()
  })
})

describe('createScoreProviderClient', () => {
  it('asks nobody when no provider is set', async () => {
    const { verdictFor, asked } = client(withAsgardex, '  ')
    expect(await verdictFor(ASGARDEX)).toEqual({ status: 'off' })
    expect(asked).toEqual([])
  })

  it('reads the descriptor, then only the bucket the identifier falls in', async () => {
    const { verdictFor, asked } = client(withAsgardex)
    expect(await verdictFor(ASGARDEX)).toMatchObject({ status: 'judged', provider: { name: 'Test provider', address: BASE }, evaluation: { name: 'ASGARDEX', trustlessity: { level: 3, privacy: false } } })
    expect(asked).toEqual([`${BASE}/provider.json`, `${BASE}/website/4c.json`])
  })

  it('finds the provider in its `score/` folder when the address names the site that publishes it', async () => {
    const site = 'http://127.0.0.1:7860'
    const { verdictFor, asked } = client(withAsgardex, `${site}/`)
    expect(await verdictFor(ASGARDEX)).toMatchObject({ status: 'judged', provider: { name: 'Test provider', address: `${site}/` } })
    expect(asked).toEqual([`${site}/provider.json`, `${BASE}/provider.json`, `${BASE}/website/4c.json`])
  })

  it('never puts the identifier itself in a request', async () => {
    const { verdictFor, asked } = client(withAsgardex)
    await verdictFor(ASGARDEX)
    expect(asked.some((url) => url.includes(ASGARDEX.slice(7)))).toBe(false)
  })

  it('reports no score for a bucket that does not exist or does not list the identifier', async () => {
    expect(await client({ [`${BASE}/provider.json`]: ok(DESCRIPTOR) }).verdictFor(ASGARDEX)).toEqual({ status: 'no-score', provider: { name: 'Test provider', address: BASE } })
    const other = 'sha256:' + '0'.repeat(64)
    const { verdictFor } = client({ ...withAsgardex, [`${BASE}/website/${bucketOf(other, 2)}.json`]: ok({ standard: SCORE_STANDARD, subject: 'website', bucket: bucketOf(other, 2), entries: [EVALUATION] }) })
    expect(await verdictFor(other)).toMatchObject({ status: 'no-score' })
  })

  it('says the provider did not answer, never "no score", when its files are missing, broken or unreachable', async () => {
    expect(await client({}).verdictFor(ASGARDEX)).toMatchObject({ status: 'unreachable', reason: expect.stringMatching(/provider\.json does not exist/) })
    expect(await client({ [`${BASE}/provider.json`]: ok({ name: 'No standard' }) }).verdictFor(ASGARDEX)).toMatchObject({ status: 'unreachable' })
    expect(await client({ [`${BASE}/provider.json`]: { kind: 'failed', reason: 'could not be reached.' } }).verdictFor(ASGARDEX)).toMatchObject({ status: 'unreachable', reason: 'could not be reached.' })
    expect(await client({ ...withAsgardex, [`${BASE}/website/4c.json`]: ok({ standard: SCORE_STANDARD, subject: 'website', bucket: '4d', entries: [] }) }).verdictFor(ASGARDEX))
      .toMatchObject({ status: 'unreachable', reason: expect.stringMatching(/different bucket/) })
    expect(await client(withAsgardex, 'not an address').verdictFor(ASGARDEX)).toMatchObject({ status: 'unreachable', address: 'not an address' })
  })

  it('keeps an answer for ten minutes and a failure for one', async () => {
    const clock = { t: 0 }
    const kept = client(withAsgardex, BASE, clock)
    await kept.verdictFor(ASGARDEX)
    clock.t = 9 * 60_000
    await kept.verdictFor(ASGARDEX)
    expect(kept.asked).toHaveLength(2)
    clock.t = 10 * 60_000
    await kept.verdictFor(ASGARDEX)
    expect(kept.asked).toHaveLength(4)

    const failing = client({ [`${BASE}/provider.json`]: { kind: 'failed', reason: 'down' } }, BASE, clock)
    await failing.verdictFor(ASGARDEX)
    await failing.verdictFor(ASGARDEX)
    expect(failing.asked).toHaveLength(1)
    clock.t += 60_000
    await failing.verdictFor(ASGARDEX)
    expect(failing.asked).toHaveLength(2)
  })

  it('shares one fetch between lookups made while it is in flight', async () => {
    const { verdictFor, asked } = client(withAsgardex)
    await Promise.all([verdictFor(ASGARDEX), verdictFor(ASGARDEX), verdictFor(ASGARDEX)])
    expect(asked).toEqual([`${BASE}/provider.json`, `${BASE}/website/4c.json`])
  })
})

describe('providerName', () => {
  function named (files: Record<string, FetchedJson>, address: string): Promise<string | undefined> {
    const provider = fakeProvider(files)
    return createScoreProviderClient({ providerAddress: () => address, isDevEthName: () => false, fetchJson: provider.fetchJson }).providerName()
  }

  it('is the name the provider gives itself, undefined with none chosen, and its address when the description cannot be read', async () => {
    expect(await named(withAsgardex, BASE)).toBe('Test provider')
    expect(await named(withAsgardex, '  ')).toBeUndefined()
    expect(await named({}, BASE)).toBe(BASE)
    expect(await named({ [`${BASE}/provider.json`]: { kind: 'failed', reason: 'down' } }, BASE)).toBe(BASE)
    expect(await named({ [`${BASE}/provider.json`]: ok({ standard: 'other' }) }, BASE)).toBe(BASE)
  })
})
