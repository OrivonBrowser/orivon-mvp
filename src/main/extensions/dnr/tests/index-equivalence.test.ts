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
 * Loads uBlock Origin Lite's real, default-enabled rulesets the same way
 * tests/perf.test.ts does (same env vars; see this file's top comment and
 * that file's for why it is not committed and not part of `npm test`).
 */
describe.skipIf(!process.env.ORIVON_DNR_PERF)('rule index equivalence: uBlock Origin Lite ruleset', () => {
  it('a few thousand varied requests decide identically with the index on or off', () => {
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

    assertIndexedMatchesUnindexed(rulesets, requests)
  }, 60000)
})
