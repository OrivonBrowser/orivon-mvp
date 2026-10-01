import { describe, expect, it } from 'vitest'
import { eligible, readableNow, readerSignal } from '../reader-signal.js'

const record = (over: Record<string, unknown> = {}): never => ({ internalPage: null, isDashboardTab: false, partition: undefined, reader: null, ...over }) as never

describe('eligible', () => {
  it('accepts an ordinary website and nothing else', () => {
    expect(eligible(record(), 'https://example.com/a')).toBe(true)
    expect(eligible(record(), 'http://example.com/a')).toBe(true)
    expect(eligible(record({ internalPage: 'settings' }), 'orivon://settings/')).toBe(false)
    expect(eligible(record({ isDashboardTab: true }), 'https://example.com/')).toBe(false)
    expect(eligible(record({ partition: 'persist:app-1' }), 'https://example.com/')).toBe(false)
    expect(eligible(record({ reader: { source: 'a' } }), 'https://example.com/')).toBe(false)
    for (const url of ['file:///a.html', 'about:blank', 'view-source:https://a.test/', 'chrome-extension://x/y.html', '']) expect(eligible(record(), url)).toBe(false)
  })
})

describe('the state it adds', () => {
  it('is not readable before the page was asked, nor without a page', () => {
    expect(readableNow(undefined)).toBe(false)
    const wc = { isDestroyed: () => false, getURL: () => 'https://example.com/' } as never
    expect(readableNow(wc)).toBe(false)
    expect(readerSignal.state?.(record(), wc)).toEqual({ readable: false })
    expect(readerSignal.state?.(record(), undefined)).toEqual({ readable: false })
  })

  it('asks once per address after the page stops loading, and forgets the answer when the address changes', async () => {
    const handlers = new Map<string, () => void>()
    let url = 'https://example.com/a'
    let asked = 0
    const wc = {
      on: (name: string, handler: () => void) => { handlers.set(name, handler) },
      getURL: () => url,
      isDestroyed: () => false,
      isCrashed: () => false,
      isLoading: () => false,
      executeJavaScriptInIsolatedWorld: async () => { asked += 1; return await Promise.resolve('true') }
    }
    let emitted = 0
    const rec = record({ host: { emitState: () => { emitted += 1 } } })
    readerSignal.wire?.({ id: 't', record: rec, view: {} as never, wc: wc as never, shown: () => true })
    handlers.get('did-stop-loading')?.()
    handlers.get('did-stop-loading')?.()
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(asked).toBe(1)
    expect(emitted).toBe(1)
    expect(readableNow(wc as never)).toBe(true)
    url = 'https://example.com/b'
    expect(readableNow(wc as never)).toBe(false)
    handlers.get('did-navigate-in-page')?.()
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(asked).toBe(2)
    expect(readableNow(wc as never)).toBe(true)
  })

  it('does not ask while the tab\'s view is swapped out', () => {
    const handlers = new Map<string, () => void>()
    let asked = 0
    const wc = { on: (name: string, handler: () => void) => { handlers.set(name, handler) }, getURL: () => 'https://example.com/', executeJavaScriptInIsolatedWorld: () => { asked += 1 } }
    readerSignal.wire?.({ id: 't', record: record(), view: {} as never, wc: wc as never, shown: () => false })
    handlers.get('did-stop-loading')?.()
    expect(asked).toBe(0)
  })
})
