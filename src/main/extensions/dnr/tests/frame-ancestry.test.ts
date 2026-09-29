import { describe, expect, it } from 'vitest'
import { FrameAncestryTracker } from '../frame-ancestry.js'
import { makeRequest } from './engine.test-helpers.js'

describe('FrameAncestryTracker', () => {
  it('returns [] for a frame it has never recorded', () => {
    const tracker = new FrameAncestryTracker()
    expect(tracker.buildAncestorChain(1, 0)).toEqual([])
  })

  it('records main_frame/sub_frame requests only', () => {
    const tracker = new FrameAncestryTracker()
    tracker.record(makeRequest({ url: 'http://x/img.png', resourceType: 'image', tabId: 1, frameId: 0 }))
    expect(tracker.buildAncestorChain(1, 0)).toEqual([])
  })

  it('builds a root-first chain for a subresource in a nested frame', () => {
    const tracker = new FrameAncestryTracker()
    tracker.record(makeRequest({ url: 'http://top/', resourceType: 'main_frame', tabId: 1, frameId: 0 }))
    tracker.record(
      makeRequest({ url: 'http://mid/', resourceType: 'sub_frame', tabId: 1, frameId: 5, parentFrameId: 0 })
    )
    tracker.record(
      makeRequest({ url: 'http://leaf/', resourceType: 'sub_frame', tabId: 1, frameId: 9, parentFrameId: 5 })
    )
    expect(tracker.buildAncestorChain(1, 9)).toEqual([
      { url: 'http://top/', initiator: null, type: 'main_frame', method: 'get' },
      { url: 'http://mid/', initiator: 'http://top/', type: 'sub_frame', method: 'get' },
      { url: 'http://leaf/', initiator: 'http://mid/', type: 'sub_frame', method: 'get' },
    ])
  })

  it('keys frames by tab, so the same frameId in another tab is unrelated', () => {
    const tracker = new FrameAncestryTracker()
    tracker.record(makeRequest({ url: 'http://tab1/', resourceType: 'main_frame', tabId: 1, frameId: 0 }))
    expect(tracker.buildAncestorChain(2, 0)).toEqual([])
  })

  it('re-recording a frame (navigation) replaces its previous entry', () => {
    const tracker = new FrameAncestryTracker()
    tracker.record(makeRequest({ url: 'http://first/', resourceType: 'main_frame', tabId: 1, frameId: 0 }))
    tracker.record(makeRequest({ url: 'http://second/', resourceType: 'main_frame', tabId: 1, frameId: 0 }))
    expect(tracker.buildAncestorChain(1, 0)).toEqual([
      { url: 'http://second/', initiator: null, type: 'main_frame', method: 'get' },
    ])
  })

  it('a broken chain (missing intermediate ancestor) returns [] rather than a partial chain', () => {
    const tracker = new FrameAncestryTracker()
    // frameId 5's parent (0) was never recorded.
    tracker.record(
      makeRequest({ url: 'http://mid/', resourceType: 'sub_frame', tabId: 1, frameId: 5, parentFrameId: 0 })
    )
    expect(tracker.buildAncestorChain(1, 5)).toEqual([])
  })
})
