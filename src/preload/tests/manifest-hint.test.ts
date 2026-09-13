// Exercises firstManifestHintHref/watchForManifestHint directly against a
// plain fake HintDocument -- this project's tests run in Node, no jsdom
// (vitest.config.ts), so there is no real DOM to attach a <link> to. The
// fake mirrors exactly what the real DOM gives these functions: a
// `readyState` string, `addEventListener`, and whatever
// `querySelectorAll('link[rel~="orivon-manifest"]')` returns.
import { describe, expect, it, vi } from 'vitest'
import { firstManifestHintHref, installManifestHintWatcher, watchForManifestHint } from '../manifest-hint.js'
import type { HintDocument } from '../manifest-hint.js'

function link (href: string): { href: string } {
  return { href }
}

/** `fireDomContentLoaded` simulates the one event this file ever listens for. */
function fakeDoc (readyState: string, links: Array<{ href: string }>): HintDocument & { fireDomContentLoaded: () => void } {
  let listener: (() => void) | undefined
  return {
    readyState,
    addEventListener: (type, cb) => { if (type === 'DOMContentLoaded') listener = cb },
    querySelectorAll: () => links,
    fireDomContentLoaded: () => { listener?.() }
  }
}

describe('firstManifestHintHref', () => {
  it('returns null when no link matches', () => {
    expect(firstManifestHintHref(fakeDoc('complete', []))).toBeNull()
  })

  it('returns the first matching link\'s href, in document order', () => {
    const doc = fakeDoc('complete', [link('https://app.example/manifest.json'), link('https://app.example/other.json')])
    expect(firstManifestHintHref(doc)).toBe('https://app.example/manifest.json')
  })

  // "First hint wins" applied literally: a malformed first hint does not
  // make a second, well-formed one count instead.
  it('treats a first link with an empty href as no hint at all -- never falls through to a later one', () => {
    const doc = fakeDoc('complete', [link(''), link('https://app.example/manifest.json')])
    expect(firstManifestHintHref(doc)).toBeNull()
  })
})

describe('watchForManifestHint', () => {
  it('scans immediately when the document is already past "loading"', () => {
    const doc = fakeDoc('complete', [link('https://app.example/manifest.json')])
    const send = vi.fn()
    watchForManifestHint(doc, send)
    expect(send).toHaveBeenCalledWith('https://app.example/manifest.json')
  })

  it('waits for DOMContentLoaded when the document is still loading, and does not scan before it fires', () => {
    const doc = fakeDoc('loading', [link('https://app.example/manifest.json')])
    const send = vi.fn()
    watchForManifestHint(doc, send)
    expect(send).not.toHaveBeenCalled()
    doc.fireDomContentLoaded()
    expect(send).toHaveBeenCalledWith('https://app.example/manifest.json')
  })

  it('never sends when no hint is present, even after DOMContentLoaded fires', () => {
    const doc = fakeDoc('loading', [])
    const send = vi.fn()
    watchForManifestHint(doc, send)
    doc.fireDomContentLoaded()
    expect(send).not.toHaveBeenCalled()
  })

  // Defence in depth over the listener's own `{ once: true }`: even if
  // something fired the event twice, the latch inside watchForManifestHint
  // must still cap this at one report.
  it('reports at most once even if DOMContentLoaded fires again', () => {
    const doc = fakeDoc('loading', [link('https://app.example/manifest.json')])
    const send = vi.fn()
    watchForManifestHint(doc, send)
    doc.fireDomContentLoaded()
    doc.fireDomContentLoaded()
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('installManifestHintWatcher', () => {
  // A real regression test, not a contrived one: this suite's own
  // environment has no `document` global at all (vitest.config.ts,
  // environment: 'node'), exactly the condition the typeof guard exists for.
  it('does nothing and does not throw when no document exists', () => {
    expect(() => { installManifestHintWatcher() }).not.toThrow()
  })
})
