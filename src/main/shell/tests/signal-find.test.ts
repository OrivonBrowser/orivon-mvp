import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { findSignal } from '../signals/find.js'
import type { TabSignalContext } from '../tab-signals.js'
import type { ShellWindow } from '../window-registry.js'

vi.mock('../../find/find-window.js', () => {
  const bars = new Map<unknown, { result: ReturnType<typeof vi.fn>, loading: ReturnType<typeof vi.fn> }>()
  return { FIND_OVERLAY: 'find', findWindowFor: (window: unknown) => bars.get(window), bars }
})

const { bars } = await import('../../find/find-window.js') as unknown as { bars: Map<unknown, { result: ReturnType<typeof vi.fn>, loading: ReturnType<typeof vi.fn> }> }

function rig (options: { shown?: boolean, barOpen?: boolean, active?: boolean } = {}): { wc: EventEmitter & { mainFrame: boolean }, owner: ShellWindow, bar: { result: ReturnType<typeof vi.fn>, loading: ReturnType<typeof vi.fn> }, close: ReturnType<typeof vi.fn> } {
  const wc = Object.assign(new EventEmitter(), { mainFrame: true, isLoadingMainFrame (): boolean { return this.mainFrame } })
  const close = vi.fn()
  const owner = { overlays: { isOpen: () => options.barOpen ?? true, close }, tabs: { activeWebContents: () => options.active === false ? {} : wc } } as unknown as ShellWindow
  const bar = { result: vi.fn(), loading: vi.fn() }
  bars.set(owner, bar)
  const record = { host: { services: { windows: { findOwner: () => owner } } } }
  findSignal.wire?.({ wc, record, shown: () => options.shown ?? true } as unknown as TabSignalContext)
  return { wc, owner, bar, close }
}

describe('the find signal', () => {
  it('hands an answer of the tab to its window\'s bar', () => {
    const { wc, bar } = rig()
    const found = { requestId: 1, activeMatchOrdinal: 1, matches: 4, finalUpdate: true }

    wc.emit('found-in-page', {}, found)

    expect(bar.result).toHaveBeenCalledWith(wc, found)
  })

  it('hands over the start and the end of a load', () => {
    const { wc, bar } = rig()

    wc.emit('did-start-loading')
    wc.emit('did-stop-loading')

    expect(bar.loading.mock.calls).toEqual([[wc, 'start'], [wc, 'stop']])
  })

  it('leaves the search alone while only a frame of the page loads', () => {
    const { wc, bar } = rig()
    wc.mainFrame = false

    wc.emit('did-start-loading')
    wc.emit('did-stop-loading')

    expect(bar.loading).not.toHaveBeenCalled()
  })

  it('ignores a view that is swapped out of its tab', () => {
    const { wc, bar, close } = rig({ shown: false })

    wc.emit('found-in-page', {}, { requestId: 1, activeMatchOrdinal: 1, matches: 1, finalUpdate: true })
    wc.emit('did-stop-loading')
    wc.emit('before-input-event', { preventDefault: vi.fn() }, { type: 'keyDown', key: 'Escape' })

    expect(bar.result).not.toHaveBeenCalled()
    expect(bar.loading).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('does nothing in a window whose bar was never shown', () => {
    const { wc, owner, bar } = rig()
    bars.delete(owner)

    expect(() => { wc.emit('found-in-page', {}, {}) }).not.toThrow()
    expect(bar.result).not.toHaveBeenCalled()
  })

  it('closes the open bar on a bare Escape in the page, without taking the key', () => {
    const { wc, close } = rig()
    const event = { preventDefault: vi.fn() }

    wc.emit('before-input-event', event, { type: 'keyDown', key: 'Escape', shift: false, control: false, alt: false, meta: false })

    expect(close).toHaveBeenCalledWith('find')
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it.each([
    ['a closed bar', { barOpen: false }, { key: 'Escape' }],
    ['a page that is not the active tab', { active: false }, { key: 'Escape' }],
    ['Escape with Ctrl', {}, { key: 'Escape', control: true }],
    ['another key', {}, { key: 'a' }],
    ['a key release', {}, { key: 'Escape', type: 'keyUp' }]
  ])('leaves the bar alone for %s', (_name, options, input) => {
    const { wc, close } = rig(options)

    wc.emit('before-input-event', { preventDefault: vi.fn() }, { type: 'keyDown', shift: false, control: false, alt: false, meta: false, ...input })

    expect(close).not.toHaveBeenCalled()
  })
})
