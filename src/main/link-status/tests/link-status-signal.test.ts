import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { TabSignalContext } from '../../shell/tab-signals.js'
import type { ShellWindow } from '../../shell/window-registry.js'

type Status = { hovered: ReturnType<typeof vi.fn>, left: ReturnType<typeof vi.fn>, checkPane: ReturnType<typeof vi.fn> }
const made = new Map<unknown, Status>()
vi.mock('../link-status-for.js', () => ({
  linkStatusFor: (window: unknown) => {
    if (!made.has(window)) made.set(window, { hovered: vi.fn(), left: vi.fn(), checkPane: vi.fn() })
    return made.get(window)
  },
  existingLinkStatus: (window: unknown) => made.get(window)
}))

const { linkStatusSignal } = await import('../link-status-signal.js')

interface Rig {
  wc: EventEmitter & { isDestroyed: () => boolean }
  owner: ShellWindow
  status: () => Status | undefined
  record: object
  shownOn: { screen: boolean, view: boolean }
}

function rig (): Rig {
  const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  const owner = {} as ShellWindow
  const shownOn = { screen: true, view: true }
  const view = { getBounds: () => ({ x: 0, y: 76, width: 1200, height: 724 }) }
  const record = { host: { isShown: () => shownOn.screen, services: { windows: { findOwner: () => owner } } } }
  linkStatusSignal.wire?.({ id: 'tab-1', wc, record, view, shown: () => shownOn.view } as unknown as TabSignalContext)
  return { wc, owner, status: () => made.get(owner), shownOn, record }
}

describe('the link status signal', () => {
  it('hands the link a page points at to its window\'s bubble, with the page area of its tab', () => {
    const { wc, status } = rig()
    wc.emit('update-target-url', {}, 'https://example.com/')

    const [tab, url] = status()?.hovered.mock.calls[0] as [{ id: string, pane: () => unknown }, string]
    expect(url).toBe('https://example.com/')
    expect(tab.id).toBe('tab-1')
    expect(tab.pane()).toEqual({ x: 0, y: 76, width: 1200, height: 724 })
  })

  it('gives no page area while the tab is not on screen', () => {
    const { wc, status, shownOn } = rig()
    wc.emit('update-target-url', {}, 'https://example.com/')
    shownOn.screen = false
    const [tab] = status()?.hovered.mock.calls[0] as [{ pane: () => unknown }]
    expect(tab.pane()).toBeUndefined()
  })

  it('makes no bubble for a page that points at no link, when its window has none', () => {
    const { wc, status } = rig()
    wc.emit('update-target-url', {}, '')
    expect(status()).toBeUndefined()
  })

  it('tells a window that has a bubble that the pointer left the link', () => {
    const { wc, status } = rig()
    wc.emit('update-target-url', {}, 'https://example.com/')
    wc.emit('update-target-url', {}, '')
    expect(status()?.hovered.mock.calls.map(([, url]) => url)).toEqual(['https://example.com/', ''])
  })

  it('ignores a view that is swapped out of its tab', () => {
    const { wc, status, shownOn } = rig()
    shownOn.view = false
    wc.emit('update-target-url', {}, 'https://example.com/')
    expect(status()).toBeUndefined()
  })

  it('tells the bubble when the page starts another document, but not for a frame or a fragment', () => {
    const { wc, status } = rig()
    wc.emit('update-target-url', {}, 'https://example.com/')

    wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(status()?.left).not.toHaveBeenCalled()

    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(status()?.left).toHaveBeenCalledWith('tab-1')
  })

  it('tells the bubble when the page crashes or is destroyed', () => {
    const { wc, status } = rig()
    wc.emit('update-target-url', {}, 'https://example.com/')
    wc.emit('render-process-gone')
    wc.emit('destroyed')
    expect(status()?.left).toHaveBeenCalledTimes(2)
  })

  it('says nothing to a bubble the page never spoke to', () => {
    const { wc, status } = rig()
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(status()).toBeUndefined()
  })
})

describe('the link status signal: the tab\'s own view', () => {
  it('says nothing of a navigation or a crash of a page whose view is no longer the tab\'s', () => {
    const { wc, status, shownOn } = rig()
    wc.emit('update-target-url', {}, 'https://example.com/')
    shownOn.view = false
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    wc.emit('render-process-gone')
    wc.emit('destroyed')
    expect(status()?.left).not.toHaveBeenCalled()
  })
})

describe('the link status signal: a push of the tabs\' state', () => {
  it('has the bubble the page spoke to check that its pane is still where it was put, and adds nothing to the state', () => {
    const { wc, status, record } = rig()
    wc.emit('update-target-url', {}, 'https://example.com/')
    expect(linkStatusSignal.state?.(record as never, wc as never)).toEqual({})
    expect(status()?.checkPane).toHaveBeenCalledOnce()
  })

  it('does nothing for a page that never spoke to a bubble, and for a destroyed one', () => {
    const { wc, status, record } = rig()
    expect(linkStatusSignal.state?.(record as never, wc as never)).toEqual({})
    expect(linkStatusSignal.state?.(record as never, undefined)).toEqual({})
    expect(status()).toBeUndefined()
  })
})
