import { describe, expect, it } from 'vitest'
import { createDnrEngine } from '../dnr-engine.js'
import { makeRequest } from './engine.test-helpers.js'

// allowAllRequests frame inheritance (test_ext_dnr_allowAllRequests.js):
// an allowAllRequests match on a main_frame or sub_frame document overrides
// a same-or-lower-priority block/redirect matched by a *subresource* load
// inside that frame (or a descendant frame). Ordering is (1) evaluate the
// document's own frame tree via evaluate(), which records it for ancestry,
// then (2) evaluate a subresource/child-frame request that references it.
describe('allowAllRequests frame inheritance', () => {
  it('an allowAllRequests match on the main_frame overrides a block on a subresource in it', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: { urlFilter: '||example.com', resourceTypes: ['main_frame'] },
          action: { type: 'allowAllRequests' },
        },
        {
          id: 2,
          priority: 1,
          condition: { urlFilter: '||ads.example.net' },
          action: { type: 'block' },
        },
      ],
    })
    // The document load itself: records tabId 1 / frameId 0 as a main_frame.
    engine.evaluate(makeRequest({ url: 'http://example.com/', resourceType: 'main_frame', tabId: 1, frameId: 0 }))
    // A subresource of that document.
    const decision = engine.evaluate(
      makeRequest({
        url: 'http://ads.example.net/pixel.gif',
        resourceType: 'image',
        tabId: 1,
        frameId: 0,
        initiator: 'http://example.com/',
      })
    )
    expect(decision.cancel).toBeUndefined()
  })

  it('does not override a higher-priority block on the subresource', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: { urlFilter: '||example.com', resourceTypes: ['main_frame'] },
          action: { type: 'allowAllRequests' },
        },
        {
          id: 2,
          priority: 2,
          condition: { urlFilter: '||ads.example.net' },
          action: { type: 'block' },
        },
      ],
    })
    engine.evaluate(makeRequest({ url: 'http://example.com/', resourceType: 'main_frame', tabId: 1, frameId: 0 }))
    const decision = engine.evaluate(
      makeRequest({ url: 'http://ads.example.net/pixel.gif', resourceType: 'image', tabId: 1, frameId: 0 })
    )
    expect(decision.cancel).toBe(true)
  })

  it('propagates through a sub_frame to a grandchild subresource', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: { urlFilter: '||example.com', resourceTypes: ['main_frame'] },
          action: { type: 'allowAllRequests' },
        },
        {
          id: 2,
          priority: 1,
          condition: { urlFilter: '||ads.example.net' },
          action: { type: 'block' },
        },
      ],
    })
    // Top document.
    engine.evaluate(makeRequest({ url: 'http://example.com/', resourceType: 'main_frame', tabId: 1, frameId: 0 }))
    // An iframe inside it.
    engine.evaluate(
      makeRequest({
        url: 'http://embed.example.org/',
        resourceType: 'sub_frame',
        tabId: 1,
        frameId: 7,
        parentFrameId: 0,
      })
    )
    // A subresource of that iframe.
    const decision = engine.evaluate(
      makeRequest({ url: 'http://ads.example.net/pixel.gif', resourceType: 'image', tabId: 1, frameId: 7 })
    )
    expect(decision.cancel).toBeUndefined()
  })

  it('an unknown frame (never recorded) falls back to no ancestry, same as an ordinary block', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: { urlFilter: '||example.com', resourceTypes: ['main_frame'] },
          action: { type: 'allowAllRequests' },
        },
        { id: 2, priority: 1, condition: { urlFilter: '||ads.example.net' }, action: { type: 'block' } },
      ],
    })
    // No main_frame request was ever evaluated for tabId 99.
    const decision = engine.evaluate(
      makeRequest({ url: 'http://ads.example.net/pixel.gif', resourceType: 'image', tabId: 99, frameId: 0 })
    )
    expect(decision.cancel).toBe(true)
  })

  it('matchedRules reports the overriding allowAllRequests rule, not the overridden block', () => {
    // The vendored RequestEvaluator only re-checks ancestry for a
    // subresource that already matched *some* rule directly (see this
    // file's top comment and extension-dnr.mjs's evaluateRequest -- a bare
    // "TODO" in upstream Firefox too, ported as-is): a block that gets
    // overridden qualifies, a subresource with no direct match at all does
    // not get its ancestry re-checked for reporting purposes.
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: { urlFilter: '||example.com', resourceTypes: ['main_frame'] },
          action: { type: 'allowAllRequests' },
        },
        { id: 2, priority: 1, condition: { urlFilter: '||ads.example.net' }, action: { type: 'block' } },
      ],
    })
    engine.evaluate(makeRequest({ url: 'http://example.com/', resourceType: 'main_frame', tabId: 1, frameId: 0 }))
    const decision = engine.evaluate(
      makeRequest({ url: 'http://ads.example.net/pixel.gif', resourceType: 'image', tabId: 1, frameId: 0 })
    )
    expect(decision.cancel).toBeUndefined()
    expect(decision.matchedRules).toContainEqual({ extensionId: 'ext', rulesetId: '_session', ruleId: 1 })
  })
})
