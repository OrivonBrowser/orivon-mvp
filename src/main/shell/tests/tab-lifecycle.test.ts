import { describe, expect, it, vi } from 'vitest'
import { TabLifecycle } from '../tab-lifecycle.js'

// TabLifecycle only ever passes these through to listeners -- plain stand-ins
// are enough, since nothing here reads any property off them.
const wc = (): any => ({ id: Symbol('wc') })
const win = (): any => ({ id: Symbol('win') })

describe('TabLifecycle', () => {
  it('fires each event on every subscribed listener', () => {
    const lifecycle = new TabLifecycle()
    const created = vi.fn()
    const activated = vi.fn()
    const closed = vi.fn()
    const replaced = vi.fn()
    lifecycle.subscribe({ tabCreated: created, tabActivated: activated, tabClosed: closed, viewReplaced: replaced })

    const a = wc()
    const b = wc()
    const w = win()
    lifecycle.tabCreated(a, w)
    lifecycle.tabActivated(a)
    lifecycle.viewReplaced(a, b, w)
    lifecycle.tabClosed(b)

    expect(created).toHaveBeenCalledWith(a, w)
    expect(activated).toHaveBeenCalledWith(a)
    expect(replaced).toHaveBeenCalledWith(a, b, w)
    expect(closed).toHaveBeenCalledWith(b)
  })

  it('fires on every subscriber, not just the first', () => {
    const lifecycle = new TabLifecycle()
    const first = vi.fn()
    const second = vi.fn()
    lifecycle.subscribe({ tabActivated: first })
    lifecycle.subscribe({ tabActivated: second })

    const a = wc()
    lifecycle.tabActivated(a)

    expect(first).toHaveBeenCalledWith(a)
    expect(second).toHaveBeenCalledWith(a)
  })

  it('tolerates a listener that only implements some events', () => {
    const lifecycle = new TabLifecycle()
    lifecycle.subscribe({}) // no handlers at all
    expect(() => { lifecycle.tabCreated(wc(), win()) }).not.toThrow()
    expect(() => { lifecycle.tabClosed(wc()) }).not.toThrow()
  })

  it('stops notifying a listener once unsubscribed', () => {
    const lifecycle = new TabLifecycle()
    const activated = vi.fn()
    const unsubscribe = lifecycle.subscribe({ tabActivated: activated })

    unsubscribe()
    lifecycle.tabActivated(wc())

    expect(activated).not.toHaveBeenCalled()
  })

  it('passes an undefined window through unchanged (no shell around the tabs yet)', () => {
    const lifecycle = new TabLifecycle()
    const created = vi.fn()
    const replaced = vi.fn()
    lifecycle.subscribe({ tabCreated: created, viewReplaced: replaced })

    const a = wc()
    const b = wc()
    lifecycle.tabCreated(a, undefined)
    lifecycle.viewReplaced(a, b, undefined)

    expect(created).toHaveBeenCalledWith(a, undefined)
    expect(replaced).toHaveBeenCalledWith(a, b, undefined)
  })
})
