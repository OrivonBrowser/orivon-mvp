import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { trackInflightUrl } from '../inflight-url.js'
import type { TabRecord } from '../tab-types.js'

function setup (shown = true): { wc: EventEmitter, record: Pick<TabRecord, 'inflightUrl'> } {
  const wc = new EventEmitter()
  const record: Pick<TabRecord, 'inflightUrl'> = {}
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

  it('follows a redirect to the newest address', () => {
    const { wc, record } = setup()
    wc.emit('did-start-navigation', start('https://a.example/'))
    wc.emit('did-start-navigation', start('https://b.example/', { isRedirect: true }))
    expect(record.inflightUrl).toBe('https://b.example/')
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
    ['finishes loading', 'did-finish-load', []],
    ['fails in the main frame', 'did-fail-load', [{}, -105, 'x', 'https://slow.example/', true]]
  ])('forgets it once the load %s', (_label, event, args) => {
    const { wc, record } = setup()
    wc.emit('did-start-navigation', start('https://slow.example/'))
    wc.emit(event, ...args)
    expect(record.inflightUrl).toBeUndefined()
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
