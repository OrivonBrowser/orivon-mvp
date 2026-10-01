import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OVERLAY_EVENT_CHANNEL } from '../../channels.js'
import type { OverlayViewSpec } from '../overlay-view.js'
import { CLOSE_LIKE_BAR, CLOSE_LIKE_POPUP } from '../overlay-types.js'
import type { OverlayCloseReason, OverlayDef, OverlayHandler } from '../overlay-types.js'

interface FakeView {
  id: number
  spec: OverlayViewSpec
  log: string[]
  sent: unknown[]
  destroyed: boolean
  bounds: unknown
  focusWanted: (() => boolean) | null
}

const { views, themeListeners, focus } = vi.hoisted(() => ({
  views: [] as FakeView[],
  themeListeners: new Set<() => void>(),
  focus: { current: undefined as unknown }
}))

vi.mock('../overlay-view.js', () => ({
  focusedContents: () => focus.current,
  createOverlayView: (spec: OverlayViewSpec) => {
    const view: FakeView = { id: 100 + views.length, spec, log: [], sent: [], destroyed: false, bounds: null, focusWanted: null }
    views.push(view)
    return {
      id: view.id,
      attach: () => { view.log.push('attach') },
      detach: () => { view.log.push('detach') },
      setBounds: (bounds: unknown) => { view.bounds = bounds },
      focusWhenReady: (wanted: () => boolean) => { view.focusWanted = wanted },
      send: (channel: string, message: unknown) => { view.sent.push([channel, message]) },
      refreshBackground: () => { view.log.push('background') },
      isDestroyed: () => view.destroyed,
      destroy: () => { view.destroyed = true; view.log.push('destroy') }
    }
  }
}))
vi.mock('../../shell/theme-colors.js', () => ({
  onThemeUpdated: (listener: () => void) => { themeListeners.add(listener); return () => { themeListeners.delete(listener) } }
}))

const { createOverlayHost } = await import('../overlay-host.js')

const ANCHOR = { x: 900, y: 40, width: 30, height: 30 }

function def (name: string, patch: Partial<OverlayDef> = {}, handler: Partial<OverlayHandler> = {}): OverlayDef {
  return {
    name, placement: { kind: 'anchor', width: 380, align: 'right' }, surface: 'panel', focus: 'take', layer: 'popup',
    closeOn: CLOSE_LIKE_POPUP, keep: 'fresh',
    attach: () => ({ request: () => undefined, ...handler }),
    ...patch
  } as OverlayDef
}

function tab (): { id: number, focus: ReturnType<typeof vi.fn>, isDestroyed: () => boolean } {
  return { id: 1, focus: vi.fn(), isDestroyed: () => false }
}

/** The chrome of the test window holds the id 5, and the tab in front the id 1; `other` windows are the ones that report focus. */
const CHROME_ID = 5

function setup (defs: OverlayDef[], active = tab(), options: { focused?: boolean, otherFocused?: boolean } = {}): { host: ReturnType<typeof createOverlayHost>, contentView: object, active: ReturnType<typeof tab>, front: { current: ReturnType<typeof tab> } } {
  const contentView = {}
  const front = { current: active }
  const win = { getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), isFocused: () => options.focused ?? true }
  const other = { window: { isDestroyed: () => false, isFocused: () => options.otherFocused ?? false } }
  const host = createOverlayHost({
    win: win as never,
    contentView: contentView as never,
    dirname: '/app',
    defs,
    context: () => ({ window: { chrome: { webContents: { id: CHROME_ID } } }, services: { windows: { all: () => [{ window: win }, other] } } }) as never,
    area: () => ({ x: 0, y: 76, width: 1200, height: 724 }),
    activeContents: () => front.current as never
  })
  return { host, contentView, active, front }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000) })
afterEach(() => { vi.useRealTimers(); views.length = 0; focus.current = undefined; themeListeners.clear() })

describe('createOverlayHost: laziness', () => {
  it('builds no view, and attaches nothing, before the first show', () => {
    const { host } = setup([def('a')])
    host.isOpen('a')
    expect(views).toHaveLength(0)
  })

  it('does not run a def\'s attach before it is used', () => {
    const attach = vi.fn(() => ({ request: () => undefined }))
    const { host } = setup([def('a', { attach })])
    expect(attach).not.toHaveBeenCalled()
    host.show('a', ANCHOR)
    expect(attach).toHaveBeenCalledTimes(1)
  })

  it('prewarm builds a warm overlay once, and nothing for a fresh one', () => {
    const { host } = setup([def('w', { keep: 'warm' }), def('f')])
    host.prewarm('w'); host.prewarm('w'); host.prewarm('f')
    expect(views).toHaveLength(1)
    expect(host.isOpen('w')).toBe(false)
  })

  it('ignores an unknown name', () => {
    const { host } = setup([def('a')])
    host.show('nope'); host.toggle('nope'); host.close('nope'); host.prewarm('nope'); host.send('nope', 1)
    expect(views).toHaveLength(0)
  })

  it('refuses two defs of the same name', () => {
    expect(() => setup([def('a'), def('a')])).toThrow(/declared twice/)
  })

  it('show attaches, sizes and reports the view shown', () => {
    const { host } = setup([def('a')])
    host.show('a', ANCHOR)
    expect(host.isOpen('a')).toBe(true)
    expect(views[0]?.log).toContain('attach')
    expect(views[0]?.bounds).toMatchObject({ x: 550, y: 76, width: 380, height: 180 })
  })
})

describe('createOverlayHost: closeOn', () => {
  const cases: Array<[string, (host: ReturnType<typeof setup>['host']) => void, keyof typeof CLOSE_LIKE_POPUP, OverlayCloseReason]> = [
    ['blur', (host) => { views[0]?.spec.onBlur() }, 'blur', 'blur'],
    ['tab switch', (host) => { host.tabSwitched() }, 'tabSwitch', 'tab-switch'],
    ['navigation', (host) => { host.navigated() }, 'navigation', 'navigation'],
    ['layout', (host) => { host.relayout() }, 'layout', 'layout']
  ]

  for (const [label, trigger, flag, reason] of cases) {
    it(`closes on ${label} when its flag is set, and reports ${reason}`, () => {
      const closed = vi.fn()
      const { host } = setup([def('a', { closeOn: { blur: false, tabSwitch: false, navigation: false, layout: false, [flag]: true } }, { closed })])
      host.show('a', ANCHOR)
      trigger(host)
      expect(host.isOpen('a')).toBe(false)
      expect(closed).toHaveBeenCalledWith(reason)
    })

    it(`stays open on ${label} when its flag is clear`, () => {
      const { host } = setup([def('a', { closeOn: { blur: true, tabSwitch: true, navigation: true, layout: true, [flag]: false } })])
      host.show('a', ANCHOR)
      trigger(host)
      expect(host.isOpen('a')).toBe(true)
    })
  }

  it('the popup preset survives navigation; the bar preset survives everything but a tab switch', () => {
    const { host } = setup([def('p'), def('b', { layer: 'bar', focus: 'never', closeOn: CLOSE_LIKE_BAR })])
    host.show('p', ANCHOR); host.show('b')
    host.navigated()
    expect(host.isOpen('p')).toBe(true)
    views[1]?.spec.onBlur(); host.relayout()
    expect(host.isOpen('b')).toBe(true)
    expect(host.isOpen('p')).toBe(false)
    host.tabSwitched()
    expect(host.isOpen('b')).toBe(false)
  })

  it('relayout repositions an overlay that survives layout, at its last reported size', () => {
    const { host } = setup([def('b', { layer: 'bar', focus: 'never', closeOn: CLOSE_LIKE_BAR, placement: { kind: 'area', at: 'top-right', width: 360 } })])
    host.show('b')
    views[0]?.spec.port.size(200)
    views[0]!.bounds = null
    host.relayout()
    expect(views[0]?.bounds).toMatchObject({ x: 824, y: 84, width: 360, height: 200 })
  })

  it('a blur or size report from a view the host already replaced is ignored', () => {
    const { host } = setup([def('a')])
    host.show('a', ANCHOR)
    const first = views[0]!
    host.close('a')
    host.show('a', ANCHOR)
    first.spec.onBlur()
    first.spec.port.size(300)
    expect(host.isOpen('a')).toBe(true)
  })

  it('a page\'s own close request, and Escape, close it', () => {
    const closed = vi.fn()
    const { host } = setup([def('a', {}, { closed })])
    host.show('a', ANCHOR)
    views[0]?.spec.port.close('escape')
    expect(closed).toHaveBeenCalledWith('escape')
    host.show('a', ANCHOR)
    views[1]?.spec.port.close('request')
    expect(closed).toHaveBeenLastCalledWith('request')
  })

  it('an overlay closes itself through its OverlayWindow', () => {
    let close = (): void => {}
    const { host } = setup([def('a', { attach: (win) => { close = win.close; return { request: () => undefined } } })])
    host.show('a', ANCHOR)
    close()
    expect(host.isOpen('a')).toBe(false)
  })

  it('reports content height only up to the def\'s own max', () => {
    const { host } = setup([def('a', { height: { max: 300, min: 100 } })])
    host.show('a', ANCHOR)
    views[0]?.spec.port.size(900)
    expect(views[0]?.bounds).toMatchObject({ height: 300 })
  })
})

describe('createOverlayHost: layers', () => {
  it('a popup replaces the open popup, and tells it so', () => {
    const closed = vi.fn()
    const { host } = setup([def('a', {}, { closed }), def('b')])
    host.show('a', ANCHOR); host.show('b', ANCHOR)
    expect(host.isOpen('a')).toBe(false)
    expect(host.isOpen('b')).toBe(true)
    expect(closed).toHaveBeenCalledWith('replaced')
  })

  it('a popup leaves an open bar alone', () => {
    const { host } = setup([def('bar', { layer: 'bar', focus: 'never', closeOn: CLOSE_LIKE_BAR }), def('pop')])
    host.show('bar'); host.show('pop', ANCHOR)
    expect(host.isOpen('bar')).toBe(true)
  })

  it('a bar does not close a popup', () => {
    const { host } = setup([def('bar', { layer: 'bar', focus: 'never', closeOn: CLOSE_LIKE_BAR }), def('pop')])
    host.show('pop', ANCHOR); host.show('bar')
    expect(host.isOpen('pop')).toBe(true)
  })

  it('close() with no name closes popups, adopted panels, and not bars', () => {
    const panel = { close: vi.fn() }
    const { host } = setup([def('bar', { layer: 'bar', focus: 'never', closeOn: CLOSE_LIKE_BAR }), def('pop')])
    host.adopt(panel)
    host.show('bar'); host.show('pop', ANCHOR)
    panel.close.mockClear()
    host.close()
    expect(host.isOpen('pop')).toBe(false)
    expect(host.isOpen('bar')).toBe(true)
    expect(panel.close).toHaveBeenCalled()
  })

  it('close(name) closes a bar', () => {
    const { host } = setup([def('bar', { layer: 'bar', focus: 'never', closeOn: CLOSE_LIKE_BAR })])
    host.show('bar')
    host.close('bar')
    expect(host.isOpen('bar')).toBe(false)
  })

  it('showing a popup closes an adopted legacy panel; a resize closes it too', () => {
    const panel = { close: vi.fn() }
    const { host } = setup([def('pop')])
    host.adopt(panel)
    host.show('pop', ANCHOR)
    expect(panel.close).toHaveBeenCalledTimes(1)
    host.relayout()
    expect(panel.close).toHaveBeenCalledTimes(2)
  })

  it('a tab switch and disposing close an adopted panel too', () => {
    const panel = { close: vi.fn() }
    const { host } = setup([def('pop')])
    host.adopt(panel)
    host.tabSwitched()
    expect(panel.close).toHaveBeenCalledTimes(1)
    host.dispose()
    expect(panel.close).toHaveBeenCalledTimes(2)
  })

  it('closeOverlays closes the popup overlays and leaves an adopted panel alone', () => {
    const panel = { close: vi.fn() }
    const { host } = setup([def('pop')])
    host.adopt(panel)
    host.show('pop', ANCHOR)
    panel.close.mockClear()
    host.closeOverlays()
    expect(host.isOpen('pop')).toBe(false)
    expect(panel.close).not.toHaveBeenCalled()
  })
})

describe('createOverlayHost: restack order', () => {
  it('attaches every open bar before any popup, whatever the show order', () => {
    const attached: number[] = []
    const { host } = setup([def('pop'), def('bar', { layer: 'bar', focus: 'never', closeOn: CLOSE_LIKE_BAR })])
    host.show('pop', ANCHOR); host.show('bar')
    for (const view of views) view.log.length = 0
    // Record the global order in which the two views are re-added.
    for (const view of views) {
      const push = view.log.push.bind(view.log)
      view.log.push = (...items: string[]) => { if (items[0] === 'attach') attached.push(view.id); return push(...items) }
    }
    host.restack()
    expect(attached).toEqual([views[1]!.id, views[0]!.id])
  })
})

describe('createOverlayHost: restack with adopted panels', () => {
  const panel = (name: string, order: string[]): { close: () => void, restack: () => void } => ({ close: vi.fn(), restack: () => { order.push(name) } })

  it('lifts an adopted panel after the bars and before the popups', () => {
    const order: string[] = []
    const { host } = setup([def('pop'), def('bar', { layer: 'bar', focus: 'never', closeOn: CLOSE_LIKE_BAR })])
    const adopted = panel('adopted', order)
    host.adopt(adopted, adopted.restack)
    host.show('bar'); host.show('pop', ANCHOR)
    order.length = 0
    for (const view of views) {
      const push = view.log.push.bind(view.log)
      view.log.push = (...items: string[]) => { if (items[0] === 'attach') order.push(view.id === views[0]?.id ? 'bar' : 'pop'); return push(...items) }
    }
    host.restack()
    expect(order).toEqual(['bar', 'adopted', 'pop'])
  })

  it('skips a panel adopted without a restack, and survives one that throws', () => {
    const complaint = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { host } = setup([def('bar', { layer: 'bar', focus: 'never', closeOn: CLOSE_LIKE_BAR })])
    const later = vi.fn()
    host.adopt({ close: vi.fn() })
    host.adopt({ close: vi.fn() }, () => { throw new Error('boom') })
    host.adopt({ close: vi.fn() }, later)
    host.show('bar')
    later.mockClear(); complaint.mockClear()
    expect(() => { host.restack() }).not.toThrow()
    expect(later).toHaveBeenCalledTimes(1)
    expect(complaint).toHaveBeenCalledTimes(1)
    complaint.mockRestore()
  })

  it('still closes an adopted panel on a tab switch when it has a restack', () => {
    const { host } = setup([def('a')])
    const adopted = panel('p', [])
    host.adopt(adopted, adopted.restack)
    host.tabSwitched()
    expect(adopted.close).toHaveBeenCalledTimes(1)
  })
})

describe('createOverlayHost: a renderer that died', () => {
  it('closes an open overlay, reports it closed and builds a fresh view on the next show', () => {
    const closed = vi.fn()
    const { host } = setup([def('a', { keep: 'warm' }, { closed })])
    host.show('a', ANCHOR)
    views[0]?.spec.onGone()
    expect(host.isOpen('a')).toBe(false)
    expect(closed).toHaveBeenCalledWith('request')
    expect(views[0]?.destroyed).toBe(true)
    host.show('a', ANCHOR)
    expect(views).toHaveLength(2)
    expect(host.isOpen('a')).toBe(true)
  })

  it('rebuilds a prewarmed overlay that was never shown', () => {
    const { host } = setup([def('w', { keep: 'warm' })])
    host.prewarm('w')
    views[0]?.spec.onGone()
    expect(views[0]?.destroyed).toBe(true)
    host.prewarm('w')
    expect(views).toHaveLength(2)
  })

  it('ignores a report from a view it already replaced', () => {
    const { host } = setup([def('w', { keep: 'warm' })])
    host.prewarm('w')
    views[0]?.spec.onGone()
    host.prewarm('w')
    views[0]?.spec.onGone()
    host.show('w', ANCHOR)
    expect(host.isOpen('w')).toBe(true)
    expect(views).toHaveLength(2)
  })
})

describe('createOverlayHost: focus', () => {
  it('a taking overlay focuses its page, and hands focus back to what held it', () => {
    const address = tab(); address.id = 5
    focus.current = address
    const { host, active } = setup([def('a')])
    host.show('a', ANCHOR)
    expect(views[0]?.focusWanted?.()).toBe(true)
    host.close('a')
    expect(address.focus).toHaveBeenCalledTimes(1)
    expect(active.focus).not.toHaveBeenCalled()
  })

  it('falls back to the active tab when nothing held focus, or it is gone', () => {
    const { host, active } = setup([def('a')])
    host.show('a', ANCHOR)
    host.close('a')
    expect(active.focus).toHaveBeenCalledTimes(1)
    const gone = { id: 9, focus: vi.fn(), isDestroyed: () => true }
    focus.current = gone
    host.show('a', ANCHOR)
    host.close('a')
    expect(gone.focus).not.toHaveBeenCalled()
    expect(active.focus).toHaveBeenCalledTimes(2)
  })

  it('does not take focus back from the page a person clicked into', () => {
    const { host, active } = setup([def('a')])
    host.show('a', ANCHOR)
    views[0]?.spec.onBlur()
    expect(host.isOpen('a')).toBe(false)
    expect(active.focus).not.toHaveBeenCalled()
  })

  it('a tab switch focuses the new active tab, not the one that held focus before', () => {
    const before = tab(); before.id = 7
    focus.current = before
    const { host, active } = setup([def('a')])
    host.show('a', ANCHOR)
    host.tabSwitched()
    expect(before.focus).not.toHaveBeenCalled()
    expect(active.focus).toHaveBeenCalledTimes(1)
  })

  it('a replaced popup does not steal focus from its replacement', () => {
    const { host, active } = setup([def('a'), def('b')])
    host.show('a', ANCHOR); host.show('b', ANCHOR)
    expect(active.focus).not.toHaveBeenCalled()
  })

  it('the replacement gives focus back to what held it before the first popup', () => {
    const address = tab(); address.id = 5
    focus.current = address
    const { host } = setup([def('a'), def('b')])
    host.show('a', ANCHOR)
    focus.current = { id: views[0]!.id, focus: vi.fn(), isDestroyed: () => false }
    host.show('b', ANCHOR)
    host.close('b')
    expect(address.focus).toHaveBeenCalledTimes(1)
  })

  it('a never-focus overlay does not ask for focus, and hands it back if a click gives it any', () => {
    const address = tab(); address.id = 5
    focus.current = address
    const { host } = setup([def('bar', { layer: 'bar', focus: 'never', closeOn: CLOSE_LIKE_BAR })])
    host.show('bar')
    expect(views[0]?.focusWanted).toBeNull()
    views[0]?.spec.onFocus()
    expect(address.focus).toHaveBeenCalledTimes(1)
  })

  it('a taking overlay ignores its own focus event', () => {
    const { host, active } = setup([def('a')])
    host.show('a', ANCHOR)
    views[0]?.spec.onFocus()
    expect(active.focus).not.toHaveBeenCalled()
  })

  it('never hands focus to a view of another window, or to a tab since switched away from', () => {
    const foreign = tab(); foreign.id = 77
    focus.current = foreign
    const { host, active } = setup([def('a')])
    host.show('a', ANCHOR)
    host.close('a')
    expect(foreign.focus).not.toHaveBeenCalled()
    expect(active.focus).toHaveBeenCalledTimes(1)
  })

  it('a bar that outlives a tab switch hands a click\'s focus to the tab in front now, not the one it was shown over', () => {
    const { host, active, front } = setup([def('bar', { layer: 'bar', focus: 'never', closeOn: { blur: false, tabSwitch: false, navigation: false, layout: false } })])
    focus.current = active
    host.show('bar')
    const next = tab(); next.id = 2
    front.current = next
    views[0]?.spec.onFocus()
    expect(active.focus).not.toHaveBeenCalled()
    expect(next.focus).toHaveBeenCalledTimes(1)
  })

  it('does not take focus in a window the person is not using', () => {
    const { host } = setup([def('a')], tab(), { focused: false, otherFocused: true })
    host.show('a', ANCHOR)
    expect(views[0]?.focusWanted).toBeNull()
  })

  it('still takes focus when no window reports focus at all', () => {
    const { host } = setup([def('a')], tab(), { focused: false, otherFocused: false })
    host.show('a', ANCHOR)
    expect(views[0]?.focusWanted).not.toBeNull()
  })

  it('focus wanted is false once the overlay closed before its page loaded', () => {
    const { host } = setup([def('a')])
    host.show('a', ANCHOR)
    host.close('a')
    expect(views[0]?.focusWanted?.()).toBe(false)
  })
})

describe('createOverlayHost: keep and reopen', () => {
  it('a fresh overlay is destroyed on close and rebuilt on the next show', () => {
    const { host } = setup([def('a')])
    host.show('a', ANCHOR); host.close('a')
    expect(views[0]?.destroyed).toBe(true)
    host.show('a', ANCHOR)
    expect(views).toHaveLength(2)
  })

  it('a warm overlay keeps its view and its last reported height', () => {
    const { host } = setup([def('w', { keep: 'warm' })])
    host.show('w', ANCHOR)
    views[0]?.spec.port.size(300)
    host.close('w')
    expect(views[0]?.destroyed).toBe(false)
    host.show('w', ANCHOR)
    expect(views).toHaveLength(1)
    expect(views[0]?.bounds).toMatchObject({ height: 300 })
  })

  it('a toggle right after a blur close is that click\'s echo and does nothing', () => {
    const { host } = setup([def('a')])
    host.show('a', ANCHOR)
    views[0]?.spec.onBlur()
    vi.advanceTimersByTime(100)
    host.toggle('a', ANCHOR)
    expect(host.isOpen('a')).toBe(false)
    vi.advanceTimersByTime(300)
    host.toggle('a', ANCHOR)
    expect(host.isOpen('a')).toBe(true)
  })

  it('a toggle of an open overlay closes it, and a request-close does not debounce the next open', () => {
    const { host } = setup([def('a')])
    host.toggle('a', ANCHOR)
    expect(host.isOpen('a')).toBe(true)
    host.toggle('a', ANCHOR)
    expect(host.isOpen('a')).toBe(false)
    host.toggle('a', ANCHOR)
    expect(host.isOpen('a')).toBe(true)
  })

  it('the debounce does not apply to an overlay that does not close on blur', () => {
    const { host } = setup([def('bar', { layer: 'bar', focus: 'never', closeOn: CLOSE_LIKE_BAR })])
    host.show('bar'); host.tabSwitched()
    host.toggle('bar')
    expect(host.isOpen('bar')).toBe(true)
  })
})

describe('createOverlayHost: what the page hears', () => {
  it('registers a def whose show validates a payload, and hands it the chrome\'s payload unchecked', async () => {
    // The shape a feature lane writes: no generic, `unknown` in, checked by the handler itself.
    const query: OverlayDef = {
      ...def('find'),
      attach: () => ({
        show: (payload) => typeof (payload as { query?: unknown } | null)?.query === 'string' ? (payload as { query: string }).query : '',
        request: () => undefined
      })
    }
    const { host } = setup([query])
    host.show('find', ANCHOR, { query: 'needle' })
    await expect(views[0]?.spec.port.ready()).resolves.toEqual({ shown: true, payload: 'needle' })
    host.close('find')
    host.show('find', ANCHOR, 42)
    await expect(views[1]?.spec.port.ready()).resolves.toEqual({ shown: true, payload: '' })
  })

  it('ready answers the show result that was waiting', async () => {
    const { host } = setup([def('a', {}, { show: (payload) => ({ got: payload }) })])
    host.show('a', ANCHOR, 'p')
    await expect(views[0]?.spec.port.ready()).resolves.toEqual({ shown: true, payload: { got: 'p' } })
    await expect(views[0]?.spec.port.ready()).resolves.toEqual({ shown: false })
  })

  it('ready of a prewarmed view that was never shown has nothing to show', async () => {
    const { host } = setup([def('w', { keep: 'warm' })])
    host.prewarm('w')
    await expect(views[0]?.spec.port.ready()).resolves.toEqual({ shown: false })
  })

  it('a later show of a ready warm page is sent as a show message', async () => {
    const { host } = setup([def('w', { keep: 'warm' }, { show: () => 'fresh' })])
    host.show('w', ANCHOR)
    await views[0]?.spec.port.ready()
    host.close('w')
    host.show('w', ANCHOR)
    await vi.advanceTimersByTimeAsync(0)
    expect(views[0]?.sent).toContainEqual([OVERLAY_EVENT_CHANNEL, { type: 'show', payload: 'fresh' }])
  })

  it('an async show result is awaited, and a throwing one shows an empty page', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { host } = setup([def('a', {}, { show: async () => await Promise.resolve(7) }), def('b', {}, { show: () => { throw new Error('x') } })])
    host.show('a', ANCHOR)
    await expect(views[0]?.spec.port.ready()).resolves.toEqual({ shown: true, payload: 7 })
    host.show('b', ANCHOR)
    await expect(views[1]?.spec.port.ready()).resolves.toEqual({ shown: true, payload: undefined })
  })

  it('send delivers to an open, ready overlay only, and holds events for one still loading', async () => {
    const { host } = setup([def('a')])
    host.send('a', 'lost')
    host.show('a', ANCHOR)
    host.send('a', 'early')
    expect(views[0]?.sent).toEqual([])
    // The held events travel in the reply that carries the show, so the page sees them after it.
    await expect(views[0]?.spec.port.ready()).resolves.toEqual({ shown: true, payload: undefined, events: ['early'] })
    expect(views[0]?.sent).toEqual([])
    host.send('a', 'late')
    expect(views[0]?.sent).toEqual([[OVERLAY_EVENT_CHANNEL, { type: 'event', event: 'late' }]])
    host.close('a')
    host.send('a', 'after')
    expect(views[0]?.sent).toHaveLength(1)
  })

  it('holds an event sent while the page waits for an async show, and delivers it in the same reply', async () => {
    let finish: (value: string) => void = () => {}
    const { host } = setup([def('a', {}, { show: async () => await new Promise<string>((resolve) => { finish = resolve }) })])
    host.show('a', ANCHOR)
    const reply = views[0]?.spec.port.ready()
    host.send('a', 'during')
    expect(views[0]?.sent).toEqual([])
    finish('shown')
    await expect(reply).resolves.toEqual({ shown: true, payload: 'shown', events: ['during'] })
    expect(views[0]?.sent).toEqual([])
  })

  it('does not hand a new view the events held for the one it replaced', async () => {
    const finishers: Array<(value: string) => void> = []
    const { host } = setup([def('a', {}, { show: async () => await new Promise<string>((resolve) => { finishers.push(resolve) }) })])
    host.show('a', ANCHOR)
    const first = views[0]?.spec.port.ready()
    host.close('a')
    host.show('a', ANCHOR)
    host.send('a', 'for the new one')
    for (const finish of finishers) finish('x')
    await expect(first).resolves.toEqual({ shown: false })
    expect(views[0]?.sent).toEqual([])
    expect(views[1]?.sent).toEqual([])
  })

  it('forgets events held for a warm page that was closed before it asked', async () => {
    const { host } = setup([def('w', { keep: 'warm' })])
    host.show('w', ANCHOR)
    host.send('w', 'stale')
    host.close('w')
    host.show('w', ANCHOR)
    await expect(views[0]?.spec.port.ready()).resolves.toEqual({ shown: true, payload: undefined })
  })

  it('leaves nothing on screen when the handler closes the overlay while it is being shown', () => {
    for (const keep of ['fresh', 'warm'] as const) {
      views.length = 0
      let close: () => void = () => {}
      const { host } = setup([{ ...def('a', { keep }), attach: (win) => { close = win.close; return { request: () => undefined, show: () => { close(); return undefined } } } }])
      host.show('a', ANCHOR)
      expect(host.isOpen('a')).toBe(false)
      expect(views[0]?.log).not.toContain('attach')
      expect(views[0]?.sent).toEqual([])
    }
  })

  it('leaves nothing on screen when the handler opens another popup over it while it is being shown', () => {
    const { host } = setup([{ ...def('a'), attach: () => ({ request: () => undefined, show: () => { host.show('b', ANCHOR); return undefined } }) }, def('b')])
    host.show('a', ANCHOR)
    expect(host.isOpen('a')).toBe(false)
    expect(host.isOpen('b')).toBe(true)
    expect(views[0]?.log).not.toContain('attach')
  })

  it('ignores an anchor that is not a rectangle of numbers', () => {
    const { host } = setup([def('a')])
    host.show('a', { x: Number.NaN, y: 1, width: 2, height: 3 })
    expect(views[0]?.bounds).toMatchObject({ x: expect.any(Number) as number })
    expect(Number.isFinite((views[0]?.bounds as { x: number }).x)).toBe(true)
  })

  it('request reaches only the handler of the def the view was built from', () => {
    const a = vi.fn(); const b = vi.fn()
    const { host } = setup([def('a', {}, { request: a }), def('b', {}, { request: b })])
    host.show('a', ANCHOR)
    views[0]?.spec.port.request('c')
    expect(a).toHaveBeenCalledWith('c')
    expect(b).not.toHaveBeenCalled()
  })

  it('a request from a view the host has since dropped does nothing', () => {
    const a = vi.fn()
    const { host } = setup([def('a', {}, { request: a })])
    host.show('a', ANCHOR)
    const first = views[0]!
    host.close('a')
    expect(first.spec.port.request('late')).toBeUndefined()
    expect(a).not.toHaveBeenCalled()
  })
})

describe('createOverlayHost: theme and dispose', () => {
  it('tells every handler the window is gone, open or shut, and survives one that throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const shut = vi.fn(); const open = vi.fn()
    const { host } = setup([def('shut', {}, { disposed: shut }), def('open', {}, { disposed: () => { open(); throw new Error('x') } }), def('unused')])
    host.show('shut', ANCHOR); host.close('shut')
    host.show('open', ANCHOR)
    host.dispose()
    expect(shut).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('repaints every built view on a theme change, once per host', () => {
    const { host } = setup([def('w', { keep: 'warm' }), def('f')])
    expect(themeListeners.size).toBe(1)
    host.prewarm('w')
    for (const listener of themeListeners) listener()
    expect(views[0]?.log).toContain('background')
  })

  it('dispose closes what is open without detaching from a dying window, destroys every view and stops listening', () => {
    const closed = vi.fn()
    const { host } = setup([def('a', {}, { closed }), def('w', { keep: 'warm' })])
    host.show('a', ANCHOR); host.prewarm('w')
    host.dispose()
    expect(closed).toHaveBeenCalledWith('window-closed')
    expect(views[0]?.log).not.toContain('detach')
    expect(views.every((view) => view.destroyed)).toBe(true)
  })

  it('unregisters its theme listener on dispose', () => {
    const { host } = setup([def('a')])
    expect(themeListeners.size).toBe(1)
    host.dispose()
    expect(themeListeners.size).toBe(0)
  })

  it('shows nothing after dispose, and disposing twice is harmless', () => {
    const { host } = setup([def('a')])
    host.dispose(); host.dispose()
    host.show('a', ANCHOR)
    expect(views).toHaveLength(0)
  })

  it('does not return focus while the window is closing', () => {
    const { host, active } = setup([def('a')])
    host.show('a', ANCHOR)
    host.dispose()
    expect(active.focus).not.toHaveBeenCalled()
  })
})
