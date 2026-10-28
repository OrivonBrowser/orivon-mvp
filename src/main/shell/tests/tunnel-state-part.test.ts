import { describe, expect, it, vi } from 'vitest'
import { tunnelStatePart } from '../state/tunnel.js'
import type { WindowContext } from '../window-context.js'

type Look = { mark: string | null, via: string | null }

function ctx (lookOf: (url: string, partition: string | undefined, choice?: string) => Look, active: { url: string, partition?: string } | null, newTabLookOf: (choice: string | undefined) => Look = () => ({ mark: null, via: null })) {
  return {
    window: { tabs: { liveWebContents: () => active === null ? undefined : { getURL: () => active.url }, partitionOf: () => active?.partition } },
    services: { tunnel: { lookOf, newTabLookOf, onChange: vi.fn(() => () => {}) } }
  } as unknown as WindowContext
}

describe('the tunnel part of the chrome state', () => {
  it('asks about the page in front and its session', () => {
    const lookOf = vi.fn(() => ({ mark: 'on', via: 'socks5' }))
    const read = tunnelStatePart.read(ctx(lookOf, { url: 'https://news.example/a', partition: 'persist:site-x' }), { tabs: [], activeTabId: 't1' } as never)
    expect(read).toEqual({ tunnel: 'on', tunnelVia: 'socks5' })
    expect(lookOf).toHaveBeenCalledWith('https://news.example/a', 'persist:site-x', undefined)
  })

  it('tells the page which choice its tab carries', () => {
    const lookOf = vi.fn(() => ({ mark: 'on', via: 'nym' }))
    tunnelStatePart.read(ctx(lookOf, { url: 'https://news.example/a', partition: 'persist:tunnel-profile' }), { tabs: [{ id: 't1', isNewTab: false, tunnelChoice: 'nym' }], activeTabId: 't1' } as never)
    expect(lookOf).toHaveBeenCalledWith('https://news.example/a', 'persist:tunnel-profile', 'nym')
  })

  it('is null with no tab in front', () => {
    expect(tunnelStatePart.read(ctx(() => ({ mark: 'on', via: 'nym' }), null), { tabs: [], activeTabId: null } as never)).toEqual({ tunnel: null, tunnelVia: null })
  })

  it('asks about the tab\'s choice, not about a page, for a new tab', () => {
    const lookOf = vi.fn(() => ({ mark: 'on', via: 'nym' }))
    const newTabLookOf = vi.fn((_choice: string | undefined) => ({ mark: 'on', via: 'socks5' }))
    const tabs = { tabs: [{ id: 't1', isNewTab: true, tunnelChoice: 'socks5' }], activeTabId: 't1' } as never
    expect(tunnelStatePart.read(ctx(lookOf, { url: 'orivon-shell://renderer/newtab/index.html' }, newTabLookOf), tabs)).toEqual({ tunnel: 'on', tunnelVia: 'socks5' })
    expect(newTabLookOf).toHaveBeenCalledWith('socks5')
    expect(lookOf).not.toHaveBeenCalled()
  })

  it('asks about a new tab that has no choice with none, and does not need a live page', () => {
    const newTabLookOf = vi.fn((_choice: string | undefined) => ({ mark: null, via: null }))
    tunnelStatePart.read(ctx(() => ({ mark: 'on', via: 'nym' }), null, newTabLookOf), { tabs: [{ id: 't1', isNewTab: true }], activeTabId: 't1' } as never)
    expect(newTabLookOf).toHaveBeenCalledWith(undefined)
  })

  it('has no look of a new tab for a blank page in a session of its own, which no new tab is: it is asked about as a page, which has none', () => {
    const lookOf = vi.fn(() => ({ mark: null, via: null }))
    const newTabLookOf = vi.fn((_choice: string | undefined) => ({ mark: 'on', via: 'nym' }))
    const tabs = { tabs: [{ id: 't1', isNewTab: true, blankInSession: true }], activeTabId: 't1' } as never
    expect(tunnelStatePart.read(ctx(lookOf, { url: 'about:blank', partition: 'persist:direct-profile' }, newTabLookOf), tabs)).toEqual({ tunnel: null, tunnelVia: null })
    expect(newTabLookOf).not.toHaveBeenCalled()
    expect(lookOf).toHaveBeenCalledWith('about:blank', 'persist:direct-profile', undefined)
  })

  it('follows the routes changing', () => {
    const context = ctx(() => ({ mark: null, via: null }), null)
    const push = vi.fn()
    tunnelStatePart.watch?.(context, push)
    expect(context.services.tunnel.onChange).toHaveBeenCalledWith(push)
  })
})
