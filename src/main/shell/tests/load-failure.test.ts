import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { loadFailed, watchLoadFailure } from '../load-failure.js'

function watched () {
  const contents = new EventEmitter()
  const changed = vi.fn()
  watchLoadFailure(contents as unknown as WebContents, changed)
  const wc = contents as unknown as WebContents
  return {
    wc, changed,
    start: (over: Record<string, unknown> = {}) => contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, ...over }),
    fail: (code = -105, isMainFrame = true) => contents.emit('did-fail-load', {}, code, 'ERR', 'https://down.example/', isMainFrame, 1, 1),
    navigated: () => contents.emit('did-navigate', {}, 'https://ok.example/')
  }
}

describe('loadFailed', () => {
  it('is false for a page nobody has watched, and for one that has not failed', () => {
    expect(loadFailed(undefined)).toBe(false)
    expect(loadFailed({} as WebContents)).toBe(false)
    const { wc, start, navigated } = watched()
    start()
    navigated()
    expect(loadFailed(wc)).toBe(false)
  })

  it('is true once a main-frame load fails, and the page is told', () => {
    const { wc, start, fail, changed } = watched()
    start()
    fail()
    expect(loadFailed(wc)).toBe(true)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('ignores a cancelled navigation and a failure in a frame inside the page', () => {
    const { wc, start, fail } = watched()
    start()
    fail(-3)
    fail(-105, false)
    expect(loadFailed(wc)).toBe(false)
  })

  it('stays true through the error page being announced as a navigation, and while the next one is only starting', () => {
    const { wc, start, fail, navigated } = watched()
    start()
    fail()
    navigated()
    expect(loadFailed(wc)).toBe(true)
    start()
    expect(loadFailed(wc)).toBe(true)
  })

  it('clears when a later navigation commits, and a same-document one is no navigation of its own', () => {
    const { wc, start, fail, navigated, changed } = watched()
    start()
    fail()
    start({ isSameDocument: true })
    navigated()
    expect(loadFailed(wc)).toBe(true)
    start()
    navigated()
    expect(loadFailed(wc)).toBe(false)
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('stays true when the next navigation fails as well', () => {
    const { wc, start, fail, navigated } = watched()
    start()
    fail()
    start()
    fail()
    navigated()
    expect(loadFailed(wc)).toBe(true)
  })
})
