import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { createUpgradeTracker } from '../https-fallback.js'
import { createFallbackSheets } from '../https-fallback-runner.js'
import { createHttpsState } from '../https-state.js'
import type { SlotAsk } from '../../overlays/tab-slots.js'
import type { ShellWindow } from '../../shell/window-registry.js'

class FakeContents extends EventEmitter {
  readonly id = 7
  destroyed = false
  isDestroyed (): boolean { return this.destroyed }
}

function rig () {
  const contents = new FakeContents()
  const window = {} as unknown as ShellWindow
  const asks: SlotAsk[] = []
  const cancel = vi.fn()
  const requestSlot = vi.fn((ask: SlotAsk) => { asks.push(ask); return { cancel } })
  const tracker = createUpgradeTracker()
  const state = createHttpsState()
  const findTab = vi.fn((c: WebContents) => (c as unknown) === contents ? { window, tabId: 't1' } : null)
  const sheets = createFallbackSheets({ tracker, state, windows: { findTab }, requestSlot })
  sheets.watch(contents as unknown as WebContents)
  return { contents, asks, requestSlot, tracker, state, sheets, window, cancel }
}

describe('the fallback sheets', () => {
  it('ask for the centre slot when the upgraded address fails to load', () => {
    const r = rig()
    r.tracker.noteUpgrade(7, 'http://site.example/a', 'https://site.example/a')
    r.contents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'https://site.example/a', true)
    expect(r.asks).toHaveLength(1)
    expect(r.asks[0]).toMatchObject({ tabId: 't1', slot: 'center', overlay: 'https-warning', payload: { tabId: 't1' } })
    expect(r.state.failed.get('t1')).toEqual({ from: 'http://site.example/a', host: 'site.example' })
  })

  it('ignores a subframe failure and an ordinary failed load', () => {
    const r = rig()
    r.tracker.noteUpgrade(7, 'http://site.example/a', 'https://site.example/a')
    r.contents.emit('did-fail-load', {}, -102, '', 'https://site.example/a', false)
    r.contents.emit('did-fail-load', {}, -102, '', 'https://elsewhere.example/', true)
    expect(r.asks).toHaveLength(0)
  })

  it('does not ask when the upgraded address loaded', () => {
    const r = rig()
    r.tracker.noteUpgrade(7, 'http://site.example/a', 'https://site.example/a')
    r.contents.emit('did-navigate', {}, 'https://site.example/a')
    r.contents.emit('did-fail-load', {}, -102, '', 'https://site.example/a', true)
    expect(r.asks).toHaveLength(0)
  })

  it('forgets the failed address when the ask ends', () => {
    const r = rig()
    r.tracker.noteUpgrade(7, 'http://site.example/a', 'https://site.example/a')
    r.contents.emit('did-fail-load', {}, -102, '', 'https://site.example/a', true)
    r.asks[0]?.closed('request')
    expect(r.state.failed.get('t1')).toBeUndefined()
  })

  it('replaces a waiting sheet with the newer failure', () => {
    const r = rig()
    r.sheets.show(r.contents as unknown as WebContents, { from: 'http://one.example/', host: 'one.example' })
    r.sheets.show(r.contents as unknown as WebContents, { from: 'http://two.example/', host: 'two.example' })
    expect(r.cancel).toHaveBeenCalledTimes(1)
    expect(r.state.failed.get('t1')?.host).toBe('two.example')
  })

  it('shows nothing for contents that is not a tab or is gone', () => {
    const r = rig()
    expect(r.sheets.show({ isDestroyed: () => false } as unknown as WebContents, { from: 'http://a.example/', host: 'a.example' })).toBe(false)
    expect(r.sheets.show(undefined, { from: 'http://a.example/', host: 'a.example' })).toBe(false)
    r.contents.destroyed = true
    expect(r.sheets.show(r.contents as unknown as WebContents, { from: 'http://a.example/', host: 'a.example' })).toBe(false)
    expect(r.requestSlot).not.toHaveBeenCalled()
  })

  it('ends the sheet when the tab starts loading another page, but not for its own error page or a fragment', () => {
    const r = rig()
    r.tracker.noteUpgrade(7, 'http://site.example/a', 'https://site.example/a')
    r.contents.emit('did-fail-load', {}, -102, '', 'https://site.example/a', true)
    r.contents.emit('did-start-navigation', { url: 'chrome-error://chromewebdata/', isMainFrame: true, isSameDocument: false })
    r.contents.emit('did-start-navigation', { url: 'https://site.example/a#x', isMainFrame: true, isSameDocument: true })
    r.contents.emit('did-start-navigation', { url: 'https://site.example/frame', isMainFrame: false, isSameDocument: false })
    expect(r.cancel).not.toHaveBeenCalled()
    r.contents.emit('did-start-navigation', { url: 'http://elsewhere.example/', isMainFrame: true, isSameDocument: false })
    expect(r.cancel).toHaveBeenCalledTimes(1)
  })

  it('follows a WebContents once however many times it is watched', () => {
    const r = rig()
    r.sheets.watch(r.contents as unknown as WebContents)
    r.tracker.noteUpgrade(7, 'http://site.example/a', 'https://site.example/a')
    r.contents.emit('did-fail-load', {}, -102, '', 'https://site.example/a', true)
    expect(r.asks).toHaveLength(1)
  })

  it('forgets a destroyed tab\'s upgrade', () => {
    const r = rig()
    r.tracker.noteUpgrade(7, 'http://site.example/a', 'https://site.example/a')
    r.contents.emit('destroyed')
    r.contents.emit('did-fail-load', {}, -102, '', 'https://site.example/a', true)
    expect(r.asks).toHaveLength(0)
  })
})
