import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { watchAppOpen } from '../app-open-watch.js'

function contents (url: string, destroyed = false): EventEmitter & { getURL: () => string, isDestroyed: () => boolean } {
  return Object.assign(new EventEmitter(), { getURL: () => url, isDestroyed: () => destroyed })
}

describe('an app opening', () => {
  it('is reported when the page of an app tab finishes loading', () => {
    const page = contents('https://app.example/')
    const opened = vi.fn()
    watchAppOpen(page as never, () => true, opened)
    expect(opened).not.toHaveBeenCalled()
    page.emit('did-finish-load')
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it('is not reported for an ordinary website', () => {
    const page = contents('https://example.com/')
    const opened = vi.fn()
    watchAppOpen(page as never, () => false, opened)
    page.emit('did-finish-load')
    expect(opened).not.toHaveBeenCalled()
  })

  it('is not reported for an empty page or a page that is gone', () => {
    const opened = vi.fn()
    for (const page of [contents(''), contents('about:blank'), contents('https://app.example/', true)]) {
      watchAppOpen(page as never, () => true, opened)
      page.emit('did-finish-load')
    }
    expect(opened).not.toHaveBeenCalled()
  })

  it('watches a page once however often it is handed over', () => {
    const page = contents('https://app.example/')
    const opened = vi.fn()
    watchAppOpen(page as never, () => true, opened)
    watchAppOpen(page as never, () => true, opened)
    page.emit('did-finish-load')
    expect(opened).toHaveBeenCalledTimes(1)
  })
})
