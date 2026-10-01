import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ExtensionDNR } from '../../../../../vendor/firefox-dnr/src/extension-dnr.mjs'
import { createDnrEngine } from '../dnr-engine.js'
import type { DnrDecision, DnrRequest, DnrRule, DnrStaticRuleset } from '../types.js'
import { makeRequest } from './engine.test-helpers.js'

/**
 * Proves that `Ruleset#getCandidateRules` (vendor/firefox-dnr/UPSTREAM.md
 * patch 10) never changes a decision: for every request in this file, the
 * indexed and unindexed evaluators are run over the SAME rules and asserted
 * to produce an identical `DnrDecision`. `ExtensionDNR.__setRuleIndexEnabledForTesting`
 * is the vendored engine's escape hatch back to a full scan, kept only for
 * this comparison (dnr-engine.ts never calls it).
 */

function evaluateAll(rulesets: DnrStaticRuleset[], requests: DnrRequest[]): DnrDecision[] {
  const engine = createDnrEngine()
  engine.setStaticRulesets('cmp', rulesets)
  return requests.map(r => engine.evaluate(r))
}

function assertIndexedMatchesUnindexed(rulesets: DnrStaticRuleset[], requests: DnrRequest[]): void {
  ExtensionDNR.__setRuleIndexEnabledForTesting(false)
  const unindexed = evaluateAll(rulesets, requests)
  ExtensionDNR.__setRuleIndexEnabledForTesting(true)
  const indexed = evaluateAll(rulesets, requests)
  expect(indexed).toEqual(unindexed)
}

describe('rule index equivalence: fixture vectors', () => {
  function loadFixture<T>(name: string): T {
    const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
    return JSON.parse(readFileSync(path, 'utf8')) as T
  }

  it('the Chrome-parity urlFilter table matches with the index on or off', () => {
    const vectors = loadFixture<Array<{ urlFilter: string; url: string; isUrlFilterCaseSensitive?: boolean }>>(
      'chrome-parity-urlfilter-vectors.json'
    )
    const rules: DnrRule[] = vectors.map((v, i) => ({
      id: i + 1,
      priority: 1,
      condition:
        v.isUrlFilterCaseSensitive === undefined
          ? { urlFilter: v.urlFilter }
          : { urlFilter: v.urlFilter, isUrlFilterCaseSensitive: v.isUrlFilterCaseSensitive },
      action: { type: 'block' },
    }))
    const requests = vectors.map(v => makeRequest({ url: v.url }))
    assertIndexedMatchesUnindexed([{ id: 'r', enabled: true, rules }], requests)
  })

  it('the ambiguous anchor/wildcard vectors match with the index on or off', () => {
    const vectors = loadFixture<
      Array<{ urlFilter: string; isUrlFilterCaseSensitive?: boolean; urls?: string[]; urlsNonMatching?: string[] }>
    >('ambiguous-urlfilter-vectors.json')
    const rules: DnrRule[] = vectors.map((v, i) => ({
      id: i + 1,
      priority: 1,
      condition:
        v.isUrlFilterCaseSensitive === undefined
          ? { urlFilter: v.urlFilter }
          : { urlFilter: v.urlFilter, isUrlFilterCaseSensitive: v.isUrlFilterCaseSensitive },
      action: { type: 'block' },
    }))
    const urls = vectors.flatMap(v => [...(v.urls ?? []), ...(v.urlsNonMatching ?? [])])
    const requests = urls.map(url => makeRequest({ url }))
    assertIndexedMatchesUnindexed([{ id: 'r', enabled: true, rules }], requests)
  })

  it('a requestDomains rule and a domain-shaped urlFilter rule agree on subdomains, superdomains and unrelated hosts', () => {
    const rules: DnrRule[] = [
      { id: 1, priority: 1, condition: { requestDomains: ['ads.example'] }, action: { type: 'block' } },
      { id: 2, priority: 1, condition: { urlFilter: '||tracker.example^' }, action: { type: 'block' } },
      { id: 3, priority: 1, condition: { urlFilter: '||cdn.example/lib/' }, action: { type: 'block' } },
      // Loose patterns that must stay generic (no trailing "^" or "/" right
      // after the domain): still must agree, since they are always tested.
      { id: 4, priority: 1, condition: { urlFilter: '||loose.example' }, action: { type: 'allow' } },
      { id: 5, priority: 2, condition: { urlFilter: 'anywhere' }, action: { type: 'block' } },
    ]
    const urls = [
      'https://ads.example/x',
      'https://a.b.ads.example/x',
      'https://notads.example/x',
      'https://tracker.example/',
      'https://sub.tracker.example/',
      'https://tracker.example.evil.net/', // must NOT match rule 2 (domain anchor)
      'https://cdn.example/lib/a.js',
      'https://cdn.example/other/a.js', // must NOT match rule 3
      'https://loose.example.evil.net/', // matches rule 4's loose pattern
      'https://loose.community/', // matches rule 4's loose pattern
      'https://anywhere.example/page?x=anywhere',
    ]
    assertIndexedMatchesUnindexed(
      [{ id: 'r', enabled: true, rules }],
      urls.map(url => makeRequest({ url }))
    )
  })
})

/**
 * vendor/firefox-dnr/UPSTREAM.md patch 11: a token index over the rules
 * patch 10 leaves generic (no domain condition). Each rule below is picked
 * to sit right at a boundary the soundness argument turns on: a token
 * bounded by a literal character, by "^", by an anchor, and a token that is
 * NOT bounded (and so must stay on the always-tested generic list). Every
 * case is checked two ways: `assertIndexedMatchesUnindexed` (the index
 * cannot change the decision) and a direct `evaluate()` assertion (the
 * decision itself is the one Chrome's urlFilter semantics require), so a
 * bug that made both paths agreeably wrong would still be caught.
 */
describe('rule index equivalence: token-index vectors', () => {
  function evaluateOne(rules: DnrRule[], url: string) {
    const engine = createDnrEngine()
    engine.setStaticRulesets('r', [{ id: 'r', enabled: true, rules }])
    return engine.evaluate(makeRequest({ url }))
  }

  it('a token bounded by literal characters on both sides narrows correctly', () => {
    // "ads" sits between two literal "/"; "track" sits between a literal
    // "/" and the pattern's own trailing "^".
    const rules: DnrRule[] = [{ id: 1, priority: 1, condition: { urlFilter: '/ads/track^' }, action: { type: 'block' } }]
    expect(evaluateOne(rules, 'https://x.example/ads/track').cancel).toBe(true)
    // "/ads" is not a substring here ("my" precedes "ads", not "/"): must
    // not match, and the token index must not be why it does or doesn't.
    expect(evaluateOne(rules, 'https://x.example/myads/track').cancel).toBeUndefined()
    // "ads" and "track" both appear as standalone URL runs, but not
    // adjoined by the required literal "/" between them: still no match,
    // proving the token index only narrows candidates -- #matchesRuleCondition
    // still re-checks the full literal.
    expect(evaluateOne(rules, 'https://x.example/pre-ads-track').cancel).toBeUndefined()

    const urls = [
      'https://x.example/ads/track',
      'https://x.example/myads/track',
      'https://x.example/pre-ads-track',
      'https://x.example/',
    ]
    assertIndexedMatchesUnindexed([{ id: 'r', enabled: true, rules }], urls.map(url => makeRequest({ url })))
  })

  it('a token bounded by a left anchor at the pattern start narrows correctly', () => {
    const rules: DnrRule[] = [
      { id: 1, priority: 1, condition: { urlFilter: '|https://cdnx.example/pixel^' }, action: { type: 'block' } },
    ]
    expect(evaluateOne(rules, 'https://cdnx.example/pixel').cancel).toBe(true)
    // Same suffix, but the URL does not literally start with the pattern:
    // the left anchor must reject it even though every token is present.
    expect(evaluateOne(rules, 'http://cdnx.example/pixel').cancel).toBeUndefined()

    const urls = ['https://cdnx.example/pixel', 'http://cdnx.example/pixel', 'https://other.example/']
    assertIndexedMatchesUnindexed([{ id: 'r', enabled: true, rules }], urls.map(url => makeRequest({ url })))
  })

  it('a token with no bounded segment (no anchor, no "^", no wildcard) stays generic and still matches embedded', () => {
    // "ads" here has nothing on either side but the pattern's own
    // unanchored start/end -- Chrome's urlFilter matches it as a plain
    // substring anywhere, including inside a longer word ("loads").
    const rules: DnrRule[] = [{ id: 1, priority: 1, condition: { urlFilter: 'ads' }, action: { type: 'block' } }]
    expect(evaluateOne(rules, 'https://loads.example/x').cancel).toBe(true)
    expect(evaluateOne(rules, 'https://x.example/ads').cancel).toBe(true)
    expect(evaluateOne(rules, 'https://x.example/nothing-here').cancel).toBeUndefined()

    const urls = ['https://loads.example/x', 'https://x.example/ads', 'https://x.example/nothing-here']
    assertIndexedMatchesUnindexed([{ id: 'r', enabled: true, rules }], urls.map(url => makeRequest({ url })))
  })

  it('a case-sensitive rule indexes under the un-lowercased token and only matches on exact case', () => {
    const rules: DnrRule[] = [
      {
        id: 1,
        priority: 1,
        condition: { urlFilter: '/ADS-track^', isUrlFilterCaseSensitive: true },
        action: { type: 'block' },
      },
    ]
    expect(evaluateOne(rules, 'https://x.example/ADS-track').cancel).toBe(true)
    expect(evaluateOne(rules, 'https://x.example/ads-track').cancel).toBeUndefined()

    const urls = ['https://x.example/ADS-track', 'https://x.example/ads-track', 'https://x.example/']
    assertIndexedMatchesUnindexed([{ id: 'r', enabled: true, rules }], urls.map(url => makeRequest({ url })))
  })

  it('stays correct across a dynamic-rule update that adds and then removes a token-indexed rule', () => {
    const engine = createDnrEngine()
    engine.setStaticRulesets('r', [{ id: 'r', enabled: true, rules: [] }])
    const url = 'https://x.example/ads/track'

    ExtensionDNR.__setRuleIndexEnabledForTesting(false)
    engine.updateDynamicRules('r', { addRules: [{ id: 1, priority: 1, condition: { urlFilter: '/ads/track^' }, action: { type: 'block' } }] })
    const unindexedAfterAdd = engine.evaluate(makeRequest({ url }))
    engine.updateDynamicRules('r', { removeRuleIds: [1] })
    const unindexedAfterRemove = engine.evaluate(makeRequest({ url }))

    const engine2 = createDnrEngine()
    engine2.setStaticRulesets('r', [{ id: 'r', enabled: true, rules: [] }])
    ExtensionDNR.__setRuleIndexEnabledForTesting(true)
    engine2.updateDynamicRules('r', { addRules: [{ id: 1, priority: 1, condition: { urlFilter: '/ads/track^' }, action: { type: 'block' } }] })
    expect(engine2.evaluate(makeRequest({ url }))).toEqual(unindexedAfterAdd)
    expect(unindexedAfterAdd.cancel).toBe(true)
    engine2.updateDynamicRules('r', { removeRuleIds: [1] })
    expect(engine2.evaluate(makeRequest({ url }))).toEqual(unindexedAfterRemove)
    expect(unindexedAfterRemove.cancel).toBeUndefined()
  })
})

/**
 * Loads uBlock Origin Lite's real, default-enabled rulesets the same way
 * tests/perf.test.ts does (same env vars; see this file's top comment and
 * that file's for why it is not committed and not part of `npm test`).
 */
/** Deterministic PRNG (mulberry32), so the synthetic uBOL run below is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed | 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The first alphanumeric (+"%") run of at least 3 characters in a urlFilter, if any. */
function firstLiteralSnippet(urlFilter: string): string | null {
  return /[a-zA-Z0-9%]{3,}/.exec(urlFilter)?.[0] ?? null
}

/**
 * Builds `count` URLs shaped like real ad/tracker requests, by taking a
 * literal snippet straight out of the loaded rulesets' own `urlFilter`
 * patterns (so the token index's actual buckets, not just hand-picked
 * strings, get exercised) and wrapping it in randomized host/path text --
 * some of it forming a real separator around the snippet (a token-index
 * bucket hit that should also be a true match) and some of it fusing the
 * snippet into a longer run (a token-index near-miss that must fall back to
 * the generic list, same as the always-on "myads" vector above).
 */
function buildRealisticAdUrls(rulesets: DnrStaticRuleset[], count: number): string[] {
  const snippets = rulesets
    .flatMap(rs => rs.rules as DnrRule[])
    .map(rule => (typeof rule.condition.urlFilter === 'string' ? firstLiteralSnippet(rule.condition.urlFilter) : null))
    .filter((s): s is string => s !== null)
  const filler = ['x', 'abc', 'foo', 'page', 'item', 'user', 'sess', 'q', 'data', 'val', 'click', 'view']
  const tlds = ['example', 'test.example', 'site.example', 'cdn.example', 'content.example']
  const rand = mulberry32(20260929)
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!

  return Array.from({ length: count }, () => {
    const snippet = pick(snippets)
    const prefix = pick(filler)
    const suffix = pick(filler)
    const host = `${prefix}${Math.floor(rand() * 1000)}.${pick(tlds)}`
    // Half the time a real separator sits on each side of the snippet (a
    // genuine token-bucket hit); the other half fuses it into a longer
    // alphanumeric run (must miss the bucket and fall back to generic).
    const leftSep = rand() < 0.5 ? '-' : ''
    const rightSep = rand() < 0.5 ? '-' : ''
    return `https://${host}/${prefix}${leftSep}${snippet}${rightSep}${suffix}${Math.floor(rand() * 100)}`
  })
}

describe.skipIf(!process.env.ORIVON_DNR_PERF)('rule index equivalence: uBlock Origin Lite ruleset', () => {
  it('over 5,000 varied requests, including URLs built from the rulesets\' own patterns, decide identically with the index on or off', () => {
    const ubolDir = process.env.ORIVON_DNR_PERF_UBOL_DIR
    if (!ubolDir) {
      throw new Error(
        'Set ORIVON_DNR_PERF_UBOL_DIR to an unpacked uBOL Lite folder -- see tests/perf.test.ts\'s top comment.'
      )
    }
    const manifest = JSON.parse(readFileSync(`${ubolDir}/manifest.json`, 'utf8')) as {
      declarative_net_request: { rule_resources: Array<{ id: string; enabled: boolean; path: string }> }
    }
    const enabledResources = manifest.declarative_net_request.rule_resources.filter(r => r.enabled)
    const rulesets: DnrStaticRuleset[] = enabledResources.map(r => ({
      id: r.id,
      enabled: true,
      rules: JSON.parse(readFileSync(`${ubolDir}${r.path}`, 'utf8')),
    }))

    // A wider mix than the perf test: ad/tracker infrastructure the rulesets
    // actually target, ordinary sites, third-level subdomains (to exercise
    // superdomain index lookups), an IP host and a bare host (index misses
    // that must still fall back correctly), main_frame/sub_frame pairs (to
    // exercise frame-ancestry allowAllRequests, which runs a second,
    // ancestor RequestDetails through the same indexed path), and every
    // resource type DNR conditions can restrict on.
    const hosts = [
      'doubleclick.net', 'googlesyndication.com', 'googletagmanager.com', 'scorecardresearch.com',
      'adnxs.com', 'facebook.com', 'google-analytics.com', 'amazon-adsystem.com', 'taboola.com', 'outbrain.com',
      'ads.sub.doubleclick.net', 'example.com', 'wikipedia.org', 'github.com', 'orivon.example',
      'news.example', 'shop.example', 'a.b.c.github.com', '203.0.113.5', 'localhost',
    ]
    const paths = ['/', '/a/b/c', '/track?x=1&y=2', '/pixel.gif', '/api/v1/data', '/static/app.js', '/frame.html']
    const resourceTypes = [
      'main_frame', 'sub_frame', 'script', 'image', 'xmlhttprequest', 'stylesheet', 'font', 'media', 'other',
    ] as const
    const methods = ['get', 'post', 'head']

    const REQUEST_COUNT = 3000
    const requests: DnrRequest[] = Array.from({ length: REQUEST_COUNT }, (_, i) => {
      const host = hosts[i % hosts.length]!
      const path = paths[i % paths.length]!
      const resourceType = resourceTypes[i % resourceTypes.length]!
      const tabId = i % 25
      // Every 7th request in a tab is a main_frame load; later requests in
      // the same tab are its sub-resources, so allowAllRequests inheritance
      // (frame-ancestry.ts) is actually exercised in both passes.
      const frameId = resourceType === 'main_frame' ? 0 : 1
      return makeRequest({
        url: `https://${host}${path}`,
        resourceType,
        method: methods[i % methods.length]!,
        initiator: `https://${hosts[(i * 3) % hosts.length]}/`,
        tabId,
        frameId,
        ...(resourceType === 'sub_frame' ? { parentFrameId: 0 } : {}),
      })
    })

    // Realistic ad/tracker-shaped URLs, synthesized from the rulesets' own
    // urlFilter patterns with random surrounding text -- see
    // buildRealisticAdUrls's own doc comment for why. REQUEST_COUNT (3000)
    // plus these (2500) is over the 5,000-request floor.
    const realisticRequests: DnrRequest[] = buildRealisticAdUrls(rulesets, 2500).map((url, i) =>
      makeRequest({
        url,
        resourceType: resourceTypes[i % resourceTypes.length]!,
        method: methods[i % methods.length]!,
        tabId: i % 25,
        frameId: 1,
      })
    )

    assertIndexedMatchesUnindexed(rulesets, [...requests, ...realisticRequests])
  }, 60000)
})
