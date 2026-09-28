import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createDnrEngine } from '../dnr-engine.js'
import { makeRequest } from './engine.test-helpers.js'
import type { DnrStaticRuleset } from '../types.js'

/**
 * Not part of `npm test` (gated on ORIVON_DNR_PERF; see this file's
 * `describe.skipIf`): loads uBlock Origin Lite's real, default-enabled
 * rulesets and times `evaluate()` over a synthetic request mix, to see
 * whether the vendored matcher's per-request linear scan over every static
 * rule (`extension-dnr.mjs`'s `RequestEvaluator#collectMatchInRuleset` --
 * ported unmodified from Firefox, which does the same thing) is fast enough
 * for a real ad-blocking extension.
 *
 * Run: download the latest `uBOLite_*.chromium.zip` from
 * https://github.com/uBlockOrigin/uBOL-home/releases, unzip it, then:
 *
 *   ORIVON_DNR_PERF=1 ORIVON_DNR_PERF_UBOL_DIR=/path/to/unzipped npx vitest run \
 *     src/main/extensions/dnr/tests/perf.test.ts
 */
describe.skipIf(!process.env.ORIVON_DNR_PERF)('performance: uBlock Origin Lite ruleset', () => {
  it('loads the default-enabled rulesets and evaluates 10,000 requests', () => {
    // A linear scan over ~18,700 rules per request (see this file's top
    // comment) legitimately takes longer than Vitest's 5s default per-test
    // timeout across 10,000 calls; this test is already excluded from the
    // default `npm test` run, so a generous timeout costs nothing there.
    const ubolDir = process.env.ORIVON_DNR_PERF_UBOL_DIR
    if (!ubolDir) {
      throw new Error(
        'Set ORIVON_DNR_PERF_UBOL_DIR to an unpacked uBOL Lite folder -- see this file\'s top comment.'
      )
    }

    const manifest = JSON.parse(readFileSync(`${ubolDir}/manifest.json`, 'utf8')) as {
      declarative_net_request: { rule_resources: Array<{ id: string; enabled: boolean; path: string }> }
    }
    const enabledResources = manifest.declarative_net_request.rule_resources.filter(r => r.enabled)

    const loadStart = performance.now()
    const rulesets: DnrStaticRuleset[] = enabledResources.map(r => ({
      id: r.id,
      enabled: true,
      rules: JSON.parse(readFileSync(`${ubolDir}${r.path}`, 'utf8')),
    }))
    const totalRules = rulesets.reduce((sum, r) => sum + r.rules.length, 0)
    const engine = createDnrEngine()
    engine.setStaticRulesets('ubol', rulesets)
    const loadMs = performance.now() - loadStart

    // A mix of URLs an ad/tracker blocker's rules are likely to react to
    // (common ad/tracker infrastructure host fragments the loaded rulesets
    // target) and ordinary same-site URLs that should evaluate to no match,
    // which is the more expensive case for a linear scan: nothing short-
    // circuits it early.
    const adLikeHosts = [
      'doubleclick.net', 'googlesyndication.com', 'googletagmanager.com', 'scorecardresearch.com',
      'adnxs.com', 'facebook.com', 'google-analytics.com', 'amazon-adsystem.com', 'taboola.com', 'outbrain.com',
    ]
    const ordinaryHosts = [
      'example.com', 'wikipedia.org', 'github.com', 'orivon.example', 'news.example', 'shop.example',
    ]
    const paths = ['/', '/a/b/c', '/track?x=1&y=2', '/pixel.gif', '/api/v1/data', '/static/app.js']
    const resourceTypes = ['script', 'image', 'xmlhttprequest', 'sub_frame', 'stylesheet'] as const

    const REQUEST_COUNT = 10000
    const requests = Array.from({ length: REQUEST_COUNT }, (_, i) => {
      const hosts = i % 3 === 0 ? adLikeHosts : ordinaryHosts
      const host = hosts[i % hosts.length]!
      const path = paths[i % paths.length]!
      return makeRequest({
        url: `https://${host}${path}`,
        resourceType: resourceTypes[i % resourceTypes.length]!,
        initiator: `https://${ordinaryHosts[i % ordinaryHosts.length]}/`,
        tabId: i % 50,
        frameId: 0,
      })
    })

    const timingsUs: number[] = []
    for (const request of requests) {
      const t0 = performance.now()
      engine.evaluate(request)
      timingsUs.push((performance.now() - t0) * 1000)
    }
    timingsUs.sort((a, b) => a - b)
    const median = timingsUs[Math.floor(timingsUs.length * 0.5)]!
    const p99 = timingsUs[Math.floor(timingsUs.length * 0.99)]!

    // eslint-disable-next-line no-console
    console.log(
      `[dnr perf] ${totalRules} rules across ${rulesets.length} rulesets, load=${loadMs.toFixed(1)}ms, ` +
        `${REQUEST_COUNT} evaluate() calls: median=${median.toFixed(1)}us p99=${p99.toFixed(1)}us`
    )

    expect(timingsUs).toHaveLength(REQUEST_COUNT)
  }, 30000)
})
