import { describe, expect, it, vi } from 'vitest'
import { tunnelStatePart } from '../state/tunnel.js'
import type { WindowContext } from '../window-context.js'

function ctx (lookOf: (url: string, partition: string | undefined) => { mark: string | null, via: string | null }, active: { url: string, partition?: string } | null) {
  return {
    window: { tabs: { liveWebContents: () => active === null ? undefined : { getURL: () => active.url }, partitionOf: () => active?.partition } },
    services: { tunnel: { lookOf, onChange: vi.fn(() => () => {}) } }
  } as unknown as WindowContext
}

describe('the tunnel part of the chrome state', () => {
  it('asks about the page in front and its session', () => {
    const lookOf = vi.fn(() => ({ mark: 'on', via: 'socks5' }))
    const read = tunnelStatePart.read(ctx(lookOf, { url: 'https://news.example/a', partition: 'persist:site-x' }), { tabs: [], activeTabId: 't1' } as never)
    expect(read).toEqual({ tunnel: 'on', tunnelVia: 'socks5' })
    expect(lookOf).toHaveBeenCalledWith('https://news.example/a', 'persist:site-x')
  })

  it('is null with no tab in front', () => {
    expect(tunnelStatePart.read(ctx(() => ({ mark: 'on', via: 'nym' }), null), { tabs: [], activeTabId: null } as never)).toEqual({ tunnel: null, tunnelVia: null })
  })

  it('follows the routes changing', () => {
    const context = ctx(() => ({ mark: null, via: null }), null)
    const push = vi.fn()
    tunnelStatePart.watch?.(context, push)
    expect(context.services.tunnel.onChange).toHaveBeenCalledWith(push)
  })
})
