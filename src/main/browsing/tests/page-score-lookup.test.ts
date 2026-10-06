import { describe, expect, it, vi } from 'vitest'
import { createPageScoreLookup, PAGE_LOOKUP_CAPACITY } from '../page-score-lookup.js'
import type { PageScoreDeps } from '../page-score-lookup.js'
import type { ManifestAtRoot } from '../../../loader/fetch/manifest-at-root.js'
import { bucketOf } from '../score-provider-client.js'
import type { FetchedJson } from '../score-provider-client.js'
import { SCORE_STANDARD } from '../../../trust/score-provider.js'

const BASE = 'http://127.0.0.1:7860/score'
const CID = 'bafybeieqer67ojhi6q3eiatmrcu3r3mqjehn7hwit2satqjfnljo65fb4q'
const CID_V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'
const ETH_CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const CALLER_A = 'http://127.0.0.1:5001'
const CALLER_B = 'http://127.0.0.1:5002'

const ok = (body: unknown): FetchedJson => ({ kind: 'ok', body })
const descriptor = { standard: SCORE_STANDARD, name: 'Test provider', bucketHexChars: 2 }
const bucketFile = (id: string, level: number): FetchedJson => ok({
  standard: SCORE_STANDARD, subject: 'website', bucket: bucketOf(id, 2), entries: [{ id, name: 'Site', evaluated: '2026-10-03', trustlessity: { level } }]
})

interface Harness {
  readonly lookup: ReturnType<typeof createPageScoreLookup>
  readonly asked: string[]
  readonly resolved: Array<{ host: string, partition: string }>
  readonly clock: { t: number }
  readonly manifestReads: Array<{ origin: string, cid: string }>
}

const appNaming = (domain: string | undefined): ManifestAtRoot => ({ kind: 'app', manifest: { domain } as never, bytes: new Uint8Array() })

function harness (files: Record<string, FetchedJson>, over: Partial<PageScoreDeps> = {}, setting = BASE): Harness {
  const asked: string[] = []
  const resolved: Array<{ host: string, partition: string }> = []
  const clock = { t: 0 }
  const manifestReads: Array<{ origin: string, cid: string }> = []
  const lookup = createPageScoreLookup({
    providerAddress: () => setting,
    isDevEthName: () => false,
    fetchJson: async (url) => { asked.push(url); return files[url] ?? { kind: 'missing' } },
    resolveEthContent: async (host, partition) => { resolved.push({ host, partition }); return host === 'scored.eth' ? ETH_CID : undefined },
    manifestAt: async (origin, cid) => { manifestReads.push({ origin, cid }); return { kind: 'website' } },
    now: () => clock.t,
    ...over
  })
  return { lookup, asked, resolved, clock, manifestReads }
}

const provided = (id: string, level: number): Record<string, FetchedJson> => ({
  [`${BASE}/provider.json`]: ok(descriptor),
  [`${BASE}/website/${bucketOf(id, 2)}.json`]: bucketFile(id, level)
})

describe('createPageScoreLookup', () => {
  it('asks nothing when no provider is chosen', async () => {
    const h = harness({}, {}, '   ')
    expect(await h.lookup.websiteScore(CALLER_A, `ipfs://${CID}`)).toEqual({ provider: null, level: null })
    expect(h.asked).toEqual([])
    expect(h.resolved).toEqual([])
  })

  it('answers an ipfs:// address with the level the provider judged, filed under its canonical cid', async () => {
    const h = harness(provided(`cid:${CID}`, 3))
    expect(await h.lookup.websiteScore(CALLER_A, `ipfs://${CID}/index.html`)).toEqual({ provider: 'Test provider', level: 3 })
    expect(h.asked).toEqual([`${BASE}/provider.json`, `${BASE}/website/${bucketOf(`cid:${CID}`, 2)}.json`])
  })

  it('files a CIDv0 under its CIDv1 form', async () => {
    const v1 = 'bafybeie5nqv6kd3qnfjupgvz34woh3oksc3iau6abmyajn7qvtf6d2ho34'
    const h = harness(provided(`cid:${v1}`, 2))
    expect(await h.lookup.websiteScore(CALLER_A, `ipfs://${CID_V0}`)).toEqual({ provider: 'Test provider', level: 2 })
  })

  it('resolves a .eth name, bare or over https, in the partition of the caller', async () => {
    const h = harness(provided(`cid:${ETH_CID}`, 4))
    expect(await h.lookup.websiteScore(CALLER_A, 'https://scored.eth/page')).toEqual({ provider: 'Test provider', level: 4 })
    expect(await h.lookup.websiteScore(CALLER_B, 'scored.eth')).toEqual({ provider: 'Test provider', level: 4 })
    expect(h.resolved).toEqual([{ host: 'scored.eth', partition: CALLER_A }, { host: 'scored.eth', partition: CALLER_B }])
  })

  describe('a judged level counts only where the content\'s manifest names the host asked about', () => {
    const resolvesBoth = async (host: string): Promise<string | undefined> => host === 'app.eth' || host === 'evil.eth' ? ETH_CID : undefined

    it('gives the level to the name the manifest names, and none to a name that points at the same content', async () => {
      const h = harness(provided(`cid:${ETH_CID}`, 4), { resolveEthContent: resolvesBoth, manifestAt: async () => appNaming('app.eth') })
      expect(await h.lookup.websiteScore(CALLER_A, 'https://app.eth')).toEqual({ provider: 'Test provider', level: 4 })
      expect(await h.lookup.websiteScore(CALLER_A, 'evil.eth')).toEqual({ provider: 'Test provider', level: null })
    })

    it('reads the manifest of the resolved root through the origin of the name asked about', async () => {
      const h = harness(provided(`cid:${ETH_CID}`, 3))
      await h.lookup.websiteScore(CALLER_A, 'https://scored.eth/page')
      expect(h.manifestReads).toEqual([{ origin: 'https://scored.eth', cid: ETH_CID }])
    })

    it('gives no level when the manifest names another home or none', async () => {
      for (const manifest of [appNaming('other.eth'), appNaming(undefined)]) {
        const h = harness(provided(`cid:${ETH_CID}`, 4), { manifestAt: async () => manifest })
        expect(await h.lookup.websiteScore(CALLER_A, 'scored.eth')).toEqual({ provider: 'Test provider', level: null })
      }
    })

    it('treats a verified absence of a manifest as a website, whose judged level stands', async () => {
      const h = harness(provided(`cid:${ETH_CID}`, 4), { manifestAt: async () => ({ kind: 'website' }) })
      expect(await h.lookup.websiteScore(CALLER_A, 'scored.eth')).toEqual({ provider: 'Test provider', level: 4 })
    })

    it('gives no level when the manifest cannot be read, or the read throws or does not answer in time', async () => {
      const unread = harness(provided(`cid:${ETH_CID}`, 4), { manifestAt: async () => ({ kind: 'unread', reason: 'down' }) })
      expect(await unread.lookup.websiteScore(CALLER_A, 'scored.eth')).toEqual({ provider: 'Test provider', level: null })
      const throws = harness(provided(`cid:${ETH_CID}`, 4), { manifestAt: async () => { throw new Error('boom') } })
      expect(await throws.lookup.websiteScore(CALLER_A, 'scored.eth')).toEqual({ provider: 'Test provider', level: null })
      vi.useFakeTimers()
      try {
        const slow = harness(provided(`cid:${ETH_CID}`, 4), { manifestAt: async () => await new Promise<ManifestAtRoot>(() => {}) })
        const asking = slow.lookup.websiteScore(CALLER_A, 'scored.eth')
        await vi.advanceTimersByTimeAsync(60_000)
        expect(await asking).toEqual({ provider: 'Test provider', level: null })
      } finally {
        vi.useRealTimers()
      }
    })

    it('reads no manifest for a judged level the shield does not bind (1 or 2), or when there is no score', async () => {
      const low = harness(provided(`cid:${ETH_CID}`, 2), { manifestAt: async () => appNaming('other.eth') })
      expect(await low.lookup.websiteScore(CALLER_A, 'scored.eth')).toEqual({ provider: 'Test provider', level: 2 })
      expect(low.manifestReads).toEqual([])
      const none = harness({ [`${BASE}/provider.json`]: ok(descriptor) })
      await none.lookup.websiteScore(CALLER_A, 'scored.eth')
      expect(none.manifestReads).toEqual([])
    })

    it('binds an ipfs:// address as the shield does: a manifest-less website keeps its level, an app never names a content address', async () => {
      const website = harness(provided(`cid:${CID}`, 3))
      expect(await website.lookup.websiteScore(CALLER_A, `ipfs://${CID}`)).toEqual({ provider: 'Test provider', level: 3 })
      expect(website.manifestReads).toEqual([{ origin: `https://${CID}.ipfs.orivon`, cid: CID }])
      const app = harness(provided(`cid:${CID}`, 3), { manifestAt: async () => appNaming('app.eth') })
      expect(await app.lookup.websiteScore(CALLER_A, `ipfs://${CID}`)).toEqual({ provider: 'Test provider', level: null })
    })
  })

  it('names the provider but gives no level for a name that does not resolve', async () => {
    const h = harness(provided(`cid:${ETH_CID}`, 4))
    expect(await h.lookup.websiteScore(CALLER_A, 'gone.eth')).toEqual({ provider: 'Test provider', level: null })
    const throws = harness(provided(`cid:${ETH_CID}`, 4), { resolveEthContent: async () => { throw new Error('no light client') } })
    expect(await throws.lookup.websiteScore(CALLER_A, 'scored.eth')).toEqual({ provider: 'Test provider', level: null })
  })

  it('gives no level for an address that names no content, and resolves nothing for it', async () => {
    const h = harness(provided(`cid:${CID}`, 3))
    for (const address of ['https://example.com', 'http://scored.eth', 'example.com', '', 'ipfs://not a cid', 'ipns://name', 'javascript:alert(1)', '.eth', 'x'.repeat(5000)]) {
      expect(await h.lookup.websiteScore(CALLER_A, address)).toEqual({ provider: 'Test provider', level: null })
    }
    expect(h.resolved).toEqual([])
    expect(h.asked.filter((url) => url.includes('/website/'))).toEqual([])
  })

  it('answers level null with the provider name when the provider has no score for the content', async () => {
    const h = harness({ [`${BASE}/provider.json`]: ok(descriptor) })
    expect(await h.lookup.websiteScore(CALLER_A, `ipfs://${CID}`)).toEqual({ provider: 'Test provider', level: null })
  })

  it('names the provider by its address when its description cannot be read, and never rejects', async () => {
    const h = harness({ [`${BASE}/provider.json`]: { kind: 'failed', reason: 'down' } })
    expect(await h.lookup.websiteScore(CALLER_A, `ipfs://${CID}`)).toEqual({ provider: BASE, level: null })
    expect(await h.lookup.websiteScore(CALLER_A, 'https://example.com')).toEqual({ provider: BASE, level: null })
    const throwing = harness({}, { fetchJson: async () => { throw new Error('boom') } })
    expect(await throwing.lookup.websiteScore(CALLER_A, `ipfs://${CID}`)).toEqual({ provider: BASE, level: null })
  })

  it('never lets one caller\'s lookups answer another: each caller asks the provider itself', async () => {
    const h = harness(provided(`cid:${CID}`, 3))
    await h.lookup.websiteScore(CALLER_A, `ipfs://${CID}`)
    const afterA = h.asked.length
    await h.lookup.websiteScore(CALLER_A, `ipfs://${CID}`)
    expect(h.asked.length).toBe(afterA)
    await h.lookup.websiteScore(CALLER_B, `ipfs://${CID}`)
    expect(h.asked.length).toBe(afterA * 2)
  })

  it('keeps the clients of the most recent callers only', async () => {
    const h = harness(provided(`cid:${CID}`, 3))
    await h.lookup.websiteScore('http://127.0.0.1:6000', `ipfs://${CID}`)
    const perCaller = h.asked.length
    for (let port = 6001; port <= 6016; port += 1) await h.lookup.websiteScore(`http://127.0.0.1:${String(port)}`, `ipfs://${CID}`)
    // The first caller was pushed out by sixteen others, so it asks again.
    await h.lookup.websiteScore('http://127.0.0.1:6000', `ipfs://${CID}`)
    expect(h.asked.length).toBe(perCaller * 18)
  })

  it('refuses past the bucket with limit, per caller, and refills with time', async () => {
    const h = harness(provided(`cid:${CID}`, 3))
    for (let i = 0; i < PAGE_LOOKUP_CAPACITY; i += 1) await h.lookup.websiteScore(CALLER_A, `ipfs://${CID}`)
    await expect(h.lookup.websiteScore(CALLER_A, `ipfs://${CID}`)).rejects.toMatchObject({ code: 'limit' })
    expect(await h.lookup.websiteScore(CALLER_B, `ipfs://${CID}`)).toEqual({ provider: 'Test provider', level: 3 })
    h.clock.t += 1000
    await h.lookup.websiteScore(CALLER_A, `ipfs://${CID}`)
    await h.lookup.websiteScore(CALLER_A, `ipfs://${CID}`)
    await expect(h.lookup.websiteScore(CALLER_A, `ipfs://${CID}`)).rejects.toMatchObject({ code: 'limit' })
  })

  it('applies a changed setting at once', async () => {
    let setting = BASE
    const h = harness(provided(`cid:${CID}`, 3), { providerAddress: () => setting })
    expect((await h.lookup.websiteScore(CALLER_A, `ipfs://${CID}`)).level).toBe(3)
    setting = ''
    expect(await h.lookup.websiteScore(CALLER_A, `ipfs://${CID}`)).toEqual({ provider: null, level: null })
  })
})
