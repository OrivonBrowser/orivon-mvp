import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { TAB_VISIBILITY_CHANNEL } from '../../channels.js'
import { TabLifecycle } from '../tab-lifecycle.js'
import { startTabVisibility } from '../tab-visibility.js'

interface Page extends EventEmitter { send: ReturnType<typeof vi.fn>, isDestroyed: () => boolean, isCrashed: () => boolean, crashed: boolean, destroy: () => void }

function page (): Page {
  const emitter = new EventEmitter() as Page
  let destroyed = false
  emitter.send = vi.fn()
  emitter.crashed = false
  emitter.isCrashed = () => emitter.crashed
  emitter.isDestroyed = () => destroyed
  emitter.destroy = () => { destroyed = true }
  return emitter
}

function windowFake (): EventEmitter & { minimized: boolean, isMinimized: () => boolean, isDestroyed: () => boolean } {
  const emitter = new EventEmitter() as EventEmitter & { minimized: boolean, isMinimized: () => boolean, isDestroyed: () => boolean }
  emitter.minimized = false
  emitter.isMinimized = () => emitter.minimized
  emitter.isDestroyed = () => false
  return emitter
}

function setup () {
  const lifecycle = new TabLifecycle()
  const stop = startTabVisibility(lifecycle)
  const win = windowFake()
  const a = page()
  const b = page()
  const c = page()
  const show = (shown: Record<string, boolean>, window: unknown = win): void => {
    const all = { a, b, c } as Record<string, ReturnType<typeof page>>
    lifecycle.shownChanged(window as never, Object.entries(shown).map(([id, isShown]) => ({ contents: all[id] as never, shown: isShown })))
  }
  const sent = (p: ReturnType<typeof page>): unknown[] => p.send.mock.calls.map((call) => call[1])
  return { lifecycle, stop, win, a, b, c, show, sent }
}

describe('startTabVisibility', () => {
  it('tells the tab that is not in front it is hidden, and the one in front nothing', () => {
    const { show, a, b, sent } = setup()
    show({ a: true, b: false })
    expect(a.send).not.toHaveBeenCalled()
    expect(sent(b)).toEqual([true])
    expect(b.send).toHaveBeenCalledWith(TAB_VISIBILITY_CHANNEL, true)
  })

  it('tells both panes of a split they are shown, and the third tab hidden', () => {
    const { show, a, b, c, sent } = setup()
    show({ a: true, b: true, c: false })
    expect(sent(a)).toEqual([])
    expect(sent(b)).toEqual([])
    expect(sent(c)).toEqual([true])
  })

  it('reports each change once and nothing when the state is unchanged', () => {
    const { show, a, b, sent } = setup()
    show({ a: true, b: false })
    show({ a: true, b: false })
    show({ a: false, b: true })
    show({ a: false, b: true })
    expect(sent(a)).toEqual([true])
    expect(sent(b)).toEqual([true, false])
  })

  it('hides every tab of a window while it is minimized, and shows the front one when it is restored', () => {
    const { show, win, a, b, sent } = setup()
    show({ a: true, b: false })
    win.minimized = true
    win.emit('minimize')
    expect(sent(a)).toEqual([true])
    expect(sent(b)).toEqual([true])
    win.minimized = false
    win.emit('restore')
    expect(sent(a)).toEqual([true, false])
    expect(sent(b)).toEqual([true])
  })

  it('hides every tab while the window is hidden, and shows them when it is shown', () => {
    const { show, win, a, sent } = setup()
    show({ a: true })
    win.emit('hide')
    expect(sent(a)).toEqual([true])
    win.emit('show')
    expect(sent(a)).toEqual([true, false])
  })

  it('treats a window that starts minimized as covered', () => {
    const { show, win, a, sent } = setup()
    win.minimized = true
    show({ a: true })
    expect(sent(a)).toEqual([true])
  })

  it('keeps a tab hidden after a change of front tab while the window is minimized', () => {
    const { show, win, a, b, sent } = setup()
    show({ a: true, b: false })
    win.minimized = true
    win.emit('minimize')
    show({ a: false, b: true })
    win.minimized = false
    win.emit('restore')
    expect(sent(a)).toEqual([true])
    expect(sent(b)).toEqual([true, false])
  })

  it('tells a page again after each main-frame navigation commits, whatever it was told before', () => {
    const { show, a, b, sent } = setup()
    show({ a: true, b: false })
    b.emit('did-navigate')
    a.emit('did-navigate')
    expect(sent(b)).toEqual([true, true])
    expect(sent(a)).toEqual([false])
  })

  it('tells a page opened in the background it is hidden when its first document commits, though nothing on screen changed', () => {
    const { lifecycle, win, a, b, show, sent } = setup()
    show({ a: true })
    lifecycle.tabCreated(b as never, win as never)
    expect(b.send).not.toHaveBeenCalled()
    b.emit('did-navigate')
    expect(sent(b)).toEqual([true])
    expect(a.send).not.toHaveBeenCalled()
  })

  it('says nothing to a new tab brought to the front at once, not even that it was hidden for a moment', () => {
    const { lifecycle, win, a, b, show, sent } = setup()
    show({ a: true })
    lifecycle.tabCreated(b as never, win as never)
    show({ a: false, b: true })
    b.emit('did-navigate')
    expect(sent(b)).toEqual([false])
    expect(sent(a)).toEqual([true])
  })

  it('gives the tab that replaces a hidden tab\'s view the same answer when its page commits', () => {
    const { lifecycle, win, b, c, show, sent } = setup()
    show({ a: true, b: false })
    lifecycle.viewReplaced(b as never, c as never, win as never)
    c.emit('did-navigate')
    expect(sent(c)).toEqual([true])
  })

  it('does not tell a page after an in-page navigation', () => {
    const { show, b, sent } = setup()
    show({ a: true, b: false })
    b.emit('did-navigate-in-page')
    expect(sent(b)).toEqual([true])
  })

  it('listens for navigations once however often the tab is listed', () => {
    const { show, b } = setup()
    show({ a: true, b: false })
    show({ a: true, b: false })
    show({ a: true, b: false })
    expect(b.listenerCount('did-navigate')).toBe(1)
  })

  it('tells nothing to a destroyed page or about a navigation of a page it never listed', () => {
    const { show, b, c } = setup()
    show({ a: true, b: false })
    b.destroy()
    expect(() => { b.emit('did-navigate') }).not.toThrow()
    c.emit('did-navigate')
    expect(c.send).not.toHaveBeenCalled()
    expect(b.send).toHaveBeenCalledTimes(1)
  })

  it('sends nothing to a page whose renderer has crashed, and tells it again when a reload commits', () => {
    const { show, b, sent } = setup()
    show({ a: true, b: false })
    b.crashed = true
    b.emit('did-navigate')
    expect(sent(b)).toEqual([true])
    b.crashed = false
    b.emit('did-navigate')
    expect(sent(b)).toEqual([true, true])
  })

  it('survives a page whose send throws', () => {
    const { show, a, b } = setup()
    b.send.mockImplementation(() => { throw new Error('Object has been destroyed') })
    expect(() => { show({ a: true, b: false }) }).not.toThrow()
    expect(a.send).not.toHaveBeenCalled()
  })

  it('follows a window handed no window at all (a test host) by shown state alone', () => {
    const { show, b, sent } = setup()
    show({ a: true, b: false }, undefined)
    expect(sent(b)).toEqual([true])
  })

  it('stops listening to the lifecycle and the windows when stopped', () => {
    const { show, stop, win, a } = setup()
    show({ a: true })
    stop()
    win.emit('hide')
    show({ a: false })
    expect(a.send).not.toHaveBeenCalled()
    expect(win.listenerCount('hide')).toBe(0)
  })

  it('lets go of a page and a window once they are gone, rather than holding them until a stop that never comes', () => {
    const { show, stop, win, a } = setup()
    show({ a: true })
    a.emit('destroyed')
    win.emit('closed')
    const pageOff = vi.spyOn(a, 'off')
    const windowOff = vi.spyOn(win, 'off')
    stop()
    expect(pageOff).not.toHaveBeenCalled()
    expect(windowOff).not.toHaveBeenCalled()
  })
})
