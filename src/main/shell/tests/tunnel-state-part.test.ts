import { describe, expect, it, vi } from 'vitest'
import { tunnelStatePart } from '../state/tunnel.js'
import type { WindowContext } from '../window-context.js'

type Look = { mark: string | null, via: string | null }

function ctx (lookOf: (url: string, partition: string | undefined, choice?: string) => Look, active: { url: string, partition?: string | undefined } | null, newTabLookOf: (choice: string | undefined) => Look = () => ({ mark: null, via: null }), isApp: (origin: string) => boolean = () => false, inflightTarget?: string) {
  return {
    window: { tabs: { liveWebContents: () => active === null ? undefined : { getURL: () => active.url }, partitionOf: () => active?.partition, record: () => ({ inflightTarget }) } },
    services: { tunnel: { lookOf, newTabLookOf, isApp, onChange: vi.fn(() => () => {}) } }
  } as unknown as WindowContext
}

describe('the tunnel part of the chrome state', () => {
  it('asks about the page in front and its session', () => {
    const lookOf = vi.fn(() => ({ mark: 'on', via: 'socks5' }))
    const read = tunnelStatePart.read(ctx(lookOf, { url: 'https://news.example/a', partition: 'persist:site-x' }), { tabs: [], activeTabId: 't1' } as never)
    expect(read).toEqual({ tunnel: 'on', tunnelVia: 'socks5', tunnelByTab: false })
    expect(lookOf).toHaveBeenCalledWith('https://news.example/a', 'persist:site-x', undefined)
  })

  it('tells the page which choice its tab carries', () => {
    const lookOf = vi.fn(() => ({ mark: 'on', via: 'nym' }))
    tunnelStatePart.read(ctx(lookOf, { url: 'https://news.example/a', partition: 'persist:tunnel-profile' }), { tabs: [{ id: 't1', isNewTab: false, tunnelChoice: 'nym' }], activeTabId: 't1' } as never)
    expect(lookOf).toHaveBeenCalledWith('https://news.example/a', 'persist:tunnel-profile', 'nym')
  })

  it('is null with no tab in front', () => {
    expect(tunnelStatePart.read(ctx(() => ({ mark: 'on', via: 'nym' }), null), { tabs: [], activeTabId: null } as never)).toEqual({ tunnel: null, tunnelVia: null, tunnelByTab: false })
  })

  it('asks about the tab\'s choice, not about a page, for a new tab', () => {
    const lookOf = vi.fn(() => ({ mark: 'on', via: 'nym' }))
    const newTabLookOf = vi.fn((_choice: string | undefined) => ({ mark: 'on', via: 'socks5' }))
    const tabs = { tabs: [{ id: 't1', isNewTab: true, tunnelChoice: 'socks5' }], activeTabId: 't1' } as never
    expect(tunnelStatePart.read(ctx(lookOf, { url: 'orivon-shell://renderer/newtab/index.html' }, newTabLookOf), tabs)).toEqual({ tunnel: 'on', tunnelVia: 'socks5', tunnelByTab: true })
    expect(newTabLookOf).toHaveBeenCalledWith('socks5')
    expect(lookOf).not.toHaveBeenCalled()
  })

  it('asks about a new tab that has no choice with none, and does not need a live page', () => {
    const newTabLookOf = vi.fn((_choice: string | undefined) => ({ mark: null, via: null }))
    tunnelStatePart.read(ctx(() => ({ mark: 'on', via: 'nym' }), null, newTabLookOf), { tabs: [{ id: 't1', isNewTab: true }], activeTabId: 't1' } as never)
    expect(newTabLookOf).toHaveBeenCalledWith(undefined)
  })

  it('has no look of a new tab for a blank page that is no dashboard, which no new tab is: it is asked about as a page, which has none', () => {
    const lookOf = vi.fn(() => ({ mark: null, via: null }))
    const newTabLookOf = vi.fn((_choice: string | undefined) => ({ mark: 'on', via: 'nym' }))
    const tabs = { tabs: [{ id: 't1', isNewTab: true, blankPage: true }], activeTabId: 't1' } as never
    expect(tunnelStatePart.read(ctx(lookOf, { url: 'about:blank', partition: 'persist:direct-profile' }, newTabLookOf), tabs)).toEqual({ tunnel: null, tunnelVia: null, tunnelByTab: false })
    expect(newTabLookOf).not.toHaveBeenCalled()
    expect(lookOf).toHaveBeenCalledWith('about:blank', 'persist:direct-profile', undefined)
  })

  describe('whether the button is about the tab, which the popover picks its list by', () => {
    const website = (over: Record<string, unknown> = {}) => ({ tabs: [{ id: 't1', isNewTab: false, isInternal: false, url: 'https://news.example/a', tunnelChoice: 'nym', ...over }], activeTabId: 't1' } as never)
    const read = (tabs: never, partition: string | undefined, isApp: (origin: string) => boolean = () => false, inflightTarget?: string) =>
      tunnelStatePart.read(ctx(() => ({ mark: 'on', via: 'nym' }), { url: 'https://news.example/a', partition }, undefined, isApp, inflightTarget), tabs)

    it('is so for a website in a tab, with a choice or without, in the shared session or a tunnel profile\'s, and for a new tab', () => {
      expect(read(website(), undefined)).toMatchObject({ tunnelByTab: true })
      expect(read(website(), 'persist:tunnel-profile')).toMatchObject({ tunnelByTab: true })
      expect(read(website({ isNewTab: true, url: 'about:blank' }), undefined)).toMatchObject({ tunnelByTab: true })
    })

    it('is so for a tab with a choice whose first page has not committed, by the address it is opening, and not so when that is an installed app', () => {
      const uncommitted = website({ url: '' })
      expect(read(uncommitted, undefined, () => false, 'https://news.example/a')).toMatchObject({ tunnelByTab: true })
      expect(read(uncommitted, undefined, (origin) => origin === 'https://app.example', 'https://app.example/')).toMatchObject({ tunnelByTab: false })
    })

    it('is not so for an installed app in a tab with a choice, whose own route decides, though the app\'s tunnel is the one the tab chose', () => {
      expect(read(website({ url: 'https://app.example/' }), undefined, (origin) => origin === 'https://app.example')).toMatchObject({ tunnel: 'on', tunnelVia: 'nym', tunnelByTab: false })
    })

    it('is not so for a page in a session an app or a temporary route made for it', () => {
      for (const partition of ['persist:app-3f9c', 'orivon-route-tab-3f9c0a']) expect(read(website(), partition), partition).toMatchObject({ tunnelByTab: false })
    })

    it('is so for a website in a tab with no choice, which the popover sets the tab\'s rows for and keeps for good only on the website\'s say-so', () => {
      expect(read(website({ tunnelChoice: undefined }), undefined)).toMatchObject({ tunnelByTab: true })
    })

    it('is not so for a page that cannot go through a tunnel, whatever the tab carries', () => {
      const local = { tabs: [{ id: 't1', isNewTab: false, isInternal: false, url: 'http://localhost:3000/', tunnelChoice: 'nym' }], activeTabId: 't1' } as never
      expect(tunnelStatePart.read(ctx(() => ({ mark: null, via: null }), { url: 'http://localhost:3000/', partition: undefined }, undefined, () => false), local)).toMatchObject({ tunnelByTab: false })
    })
  })

  it('follows the routes changing', () => {
    const context = ctx(() => ({ mark: null, via: null }), null)
    const push = vi.fn()
    tunnelStatePart.watch?.(context, push)
    expect(context.services.tunnel.onChange).toHaveBeenCalledWith(push)
  })
})
