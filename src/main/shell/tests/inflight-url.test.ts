import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { trackInflightUrl } from '../inflight-url.js'
import type { TabRecord } from '../tab-types.js'

function setup (shown = true): { wc: EventEmitter, record: Pick<TabRecord, 'inflightUrl' | 'inflightTarget'> } {
  const wc = new EventEmitter()
  const record: Pick<TabRecord, 'inflightUrl' | 'inflightTarget'> = {}
  trackInflightUrl(wc as never, record, () => shown)
  return { wc, record }
}

const start = (url: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ url, isMainFrame: true, isSameDocument: false, ...extra })

describe('the address a tab is loading but has not committed', () => {
  it('records the main frame\'s navigation as it starts', () => {
    const { wc, record } = setup()
    wc.emit('did-start-navigation', start('https://slow.example/'))
    expect(record.inflightUrl).toBe('https://slow.example/')
  })

  it('ignores a subframe and a same-document navigation', () => {
    const { wc, record } = setup()
    wc.emit('did-start-navigation', start('https://frame.example/', { isMainFrame: false }))
    wc.emit('did-start-navigation', start('https://a.example/#x', { isSameDocument: true }))
    expect(record.inflightUrl).toBeUndefined()
  })

  it.each([
    ['commits', 'did-navigate', [{}, 'https://slow.example/']],
    ['stops loading', 'did-stop-loading', []],
    ['fails in the main frame', 'did-fail-load', [{}, -105, 'x', 'https://slow.example/', true]],
    ['is cancelled before it commits', 'did-fail-provisional-load', [{}, -3, 'ERR_ABORTED', 'https://slow.example/', true]]
  ])('forgets it once the load %s', (_label, event, args) => {
    const { wc, record } = setup()
    wc.emit('did-start-navigation', start('https://slow.example/'))
    wc.emit(event, ...args)
    expect(record.inflightUrl).toBeUndefined()
  })

  it('keeps it when the page being left finishes its own load', () => {
    const { wc, record } = setup()
    wc.emit('did-start-navigation', start('https://slow.example/'))
    wc.emit('did-finish-load')
    expect(record.inflightUrl).toBe('https://slow.example/')
  })

  it('keeps it when the abort of the navigation it replaced arrives after', () => {
    const { wc, record } = setup()
    wc.emit('did-start-navigation', start('https://old.example/'))
    wc.emit('did-start-navigation', start('https://slow.example/'))
    wc.emit('did-fail-provisional-load', {}, -3, 'ERR_ABORTED', 'https://old.example/', true)
    expect(record.inflightUrl).toBe('https://slow.example/')
  })

  it('forgets it when the navigation fails at the address a redirect led to', () => {
    const { wc, record } = setup()
    wc.emit('did-start-navigation', start('https://a.example/'))
    wc.emit('did-redirect-navigation', { url: 'https://b.example/', isMainFrame: true })
    expect(record.inflightUrl).toBe('https://a.example/')
    wc.emit('did-fail-load', {}, -105, 'x', 'https://b.example/', true)
    expect(record.inflightUrl).toBeUndefined()
  })

  it('follows the load through its redirects as its target, while the address it started at stays what Reload restarts', () => {
    const { wc, record } = setup()
    wc.emit('did-start-navigation', start('https://t.example/x'))
    expect(record.inflightTarget).toBe('https://t.example/x')
    wc.emit('did-redirect-navigation', { url: 'https://news.example/a', isMainFrame: true })
    wc.emit('did-redirect-navigation', { url: 'https://frame.example/', isMainFrame: false })
    expect(record.inflightUrl).toBe('https://t.example/x')
    expect(record.inflightTarget).toBe('https://news.example/a')
    wc.emit('did-navigate', {}, 'https://news.example/a')
    expect(record.inflightTarget).toBeUndefined()
  })

  it('keeps it when only a subframe fails', () => {
    const { wc, record } = setup()
    wc.emit('did-start-navigation', start('https://slow.example/'))
    wc.emit('did-fail-load', {}, -105, 'x', 'https://frame.example/', false)
    expect(record.inflightUrl).toBe('https://slow.example/')
  })

  it('records nothing for a view the tab no longer shows', () => {
    const { wc, record } = setup(false)
    wc.emit('did-start-navigation', start('https://slow.example/'))
    expect(record.inflightUrl).toBeUndefined()
  })
})

describe('a view the tab has swapped out', () => {
  /** Two views of one tab, as repartitionView leaves them: the old one is in front until `swap()`, which parks it and puts the new one in front. */
  function views (): { old: EventEmitter, now: EventEmitter, record: Pick<TabRecord, 'inflightUrl' | 'inflightTarget'>, swap: () => void, back: () => void } {
    const record: Pick<TabRecord, 'inflightUrl' | 'inflightTarget'> = {}
    const old = new EventEmitter()
    const now = new EventEmitter()
    let inFront: EventEmitter = old
    trackInflightUrl(old as never, record, () => inFront === old)
    trackInflightUrl(now as never, record, () => inFront === now)
    return { old, now, record, swap: () => { inFront = now }, back: () => { inFront = old } }
  }

  it('does not end the load of the view in front when its parked about:blank commits after that load has started', () => {
    const { old, now, record, swap } = views()
    swap()
    now.emit('did-start-navigation', start('https://slow.example/'))
    old.emit('did-start-navigation', start('about:blank'))
    old.emit('did-navigate', {}, 'about:blank')
    old.emit('did-stop-loading')
    expect(record.inflightUrl).toBe('https://slow.example/')
    expect(record.inflightTarget).toBe('https://slow.example/')
  })

  it('does not end it when the load the old view was in the middle of is aborted', () => {
    const { old, now, record, swap } = views()
    old.emit('did-start-navigation', start('https://slow.example/'))
    swap()
    now.emit('did-start-navigation', start('https://slow.example/'))
    old.emit('did-fail-provisional-load', {}, -3, 'ERR_ABORTED', 'https://slow.example/', true)
    expect(record.inflightUrl).toBe('https://slow.example/')
    expect(record.inflightTarget).toBe('https://slow.example/')
  })

  it('does not follow a redirect of the old view, and still follows the one of the view in front', () => {
    const { old, now, record, swap } = views()
    swap()
    now.emit('did-start-navigation', start('https://slow.example/'))
    old.emit('did-redirect-navigation', { url: 'https://elsewhere.example/', isMainFrame: true })
    expect(record.inflightTarget).toBe('https://slow.example/')
    now.emit('did-redirect-navigation', { url: 'https://news.example/a', isMainFrame: true })
    expect(record.inflightTarget).toBe('https://news.example/a')
    now.emit('did-navigate', {}, 'https://news.example/a')
    expect(record.inflightTarget).toBeUndefined()
  })

  it('forgets what it was loading while it was in front, so that coming back to the front it ends only its own load', () => {
    const { old, now, record, swap, back } = views()
    old.emit('did-start-navigation', start('https://old.example/'))
    swap()
    old.emit('did-navigate', {}, 'about:blank')
    now.emit('did-start-navigation', start('https://slow.example/'))
    back()
    old.emit('did-fail-load', {}, -105, 'x', 'https://old.example/', true)
    expect(record.inflightTarget).toBe('https://slow.example/')
  })
})
