import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createDnrEngine } from '../dnr-engine.js'
import { makeRequest } from './engine.test-helpers.js'
import type { DnrRequest, DnrStaticRuleset } from '../types.js'

/**
 * Not part of `npm test` (gated on ORIVON_DNR_PERF, same as perf.test.ts
 * and index-equivalence.test.ts's uBOL describe block; see perf.test.ts's
 * top comment for how to obtain a real uBOL Lite folder).
 *
 * Regression coverage for vendor/firefox-dnr/UPSTREAM.md patch 13/14: loads
 * every one of uBlock Origin Lite's default-enabled rulesets (including
 * `ublock-filters.json`'s handful of `condition.responseHeaders` rules,
 * which patch 14 now rejects at validation -- setStaticRulesets must still
 * load the rest of that ruleset, not fail the whole load) and evaluates a
 * request mix -- ordinary https(s) requests plus the data:/blob:/about:
 * requests that made `evaluate()` throw before patch 13 -- once per
 * webRequest phase (`../dnr-webrequest.ts`'s own doc: onBeforeRequest,
 * onBeforeSendHeaders and onHeadersReceived each call `engine.evaluate()`
 * independently on the same request, never sharing one decision), asserting
 * no call throws.
 */
describe.skipIf(!process.env.ORIVON_DNR_PERF)('real ruleset safety: uBlock Origin Lite default rulesets', () => {
  it('setStaticRulesets loads every default-enabled ruleset, and evaluate() never throws across three phases', () => {
    const ubolDir = process.env.ORIVON_DNR_PERF_UBOL_DIR
    if (!ubolDir) {
      throw new Error(
        'Set ORIVON_DNR_PERF_UBOL_DIR to an unpacked uBOL Lite folder -- see perf.test.ts\'s top comment.'
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
    const totalRules = rulesets.reduce((sum, r) => sum + r.rules.length, 0)

    const engine = createDnrEngine()
    // Must not throw: ublock-filters.json alone has rules with
    // condition.responseHeaders (patch 14 rejects them at validation), and
    // setStaticRulesets must drop only those, not the whole ruleset.
    engine.setStaticRulesets('ubol', rulesets)
    expect(engine.getEnabledRulesets('ubol')).toEqual(enabledResources.map(r => r.id))

    const hosts = [
      'doubleclick.net', 'googlesyndication.com', 'example.com', 'a.b.c.github.com',
      '203.0.113.5', 'localhost', 'news.example',
    ]
    const paths = ['/', '/a/b/c', '/track?x=1&y=2', '/pixel.gif', '/api/v1/data']
    const resourceTypes = [
      'main_frame', 'sub_frame', 'script', 'image', 'xmlhttprequest', 'stylesheet', 'font', 'media', 'other',
    ] as const
    const methods = ['get', 'post', 'head']

    const httpsRequests: DnrRequest[] = Array.from({ length: 400 }, (_, i) => {
      const host = hosts[i % hosts.length]!
      const path = paths[i % paths.length]!
      const resourceType = resourceTypes[i % resourceTypes.length]!
      return makeRequest({
        url: `https://${host}${path}`,
        resourceType,
        method: methods[i % methods.length]!,
        initiator: `https://${hosts[(i * 3) % hosts.length]}/`,
        tabId: i % 10,
        frameId: resourceType === 'main_frame' ? 0 : 1,
        ...(resourceType === 'sub_frame' ? { parentFrameId: 0 } : {}),
      })
    })

    // Empty-hostname requests (patch 13's exact regression shape): every
    // scheme whose URL has no host, each seen with and without an
    // initiator, and with/without resourceTypes that commonly reach this
    // engine for such loads.
    const emptyHostnameRequests: DnrRequest[] = [
      'data:text/plain,hello', 'data:image/png;base64,iVBORw0KGgo=', 'blob:https://example.com/1234-5678',
      'about:blank', 'about:srcdoc', 'javascript:void(0)',
    ].flatMap((url, i) => [
      makeRequest({ url, resourceType: 'xmlhttprequest', tabId: i, frameId: 1 }),
      makeRequest({ url, resourceType: 'sub_frame', initiator: 'https://example.com/', tabId: i, frameId: 2, parentFrameId: 0 }),
      makeRequest({ url, resourceType: 'script', initiator: 'https://doubleclick.net/', tabId: i, frameId: 1 }),
    ])

    const allRequests = [...httpsRequests, ...emptyHostnameRequests]
    let totalMatches = 0
    for (const request of allRequests) {
      // dnr-webrequest.ts calls engine.evaluate() independently at each of
      // the three webRequest phases (onBeforeRequest, onBeforeSendHeaders,
      // onHeadersReceived) -- simulate all three here rather than only one.
      for (let phase = 0; phase < 3; phase++) {
        const decision = engine.evaluate(request)
        totalMatches += decision.matchedRules.length
      }
    }

    expect(totalRules).toBeGreaterThan(1000)
    expect(allRequests.length).toBeGreaterThan(400)
    // Not the point of this test (index-equivalence.test.ts covers
    // correctness), but a decision was actually computed for real rules.
    expect(totalMatches).toBeGreaterThan(0)
  }, 60000)
})
