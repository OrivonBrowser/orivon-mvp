import { describe, expect, it, vi } from 'vitest'
import { tunnelStatePart } from '../state/tunnel.js'
import type { WindowContext } from '../window-context.js'

function ctx (markOf: (url: string, partition: string | undefined) => string | null, active: { url: string, partition?: string } | null) {
  return {
    window: { tabs: { liveWebContents: () => active === null ? undefined : { getURL: () => active.url }, partitionOf: () => active?.partition } },
    services: { tunnel: { markOf, onChange: vi.fn(() => () => {}) } }
  } as unknown as WindowContext
}

describe('the tunnel part of the chrome state', () => {
  it('asks about the page in front and its session', () => {
    const markOf = vi.fn(() => 'on')
    const read = tunnelStatePart.read(ctx(markOf, { url: 'https://news.example/a', partition: 'persist:site-x' }), { tabs: [], activeTabId: 't1' } as never)
    expect(read).toEqual({ tunnel: 'on' })
    expect(markOf).toHaveBeenCalledWith('https://news.example/a', 'persist:site-x')
  })

  it('is null with no tab in front', () => {
    expect(tunnelStatePart.read(ctx(() => 'on', null), { tabs: [], activeTabId: null } as never)).toEqual({ tunnel: null })
  })

  it('follows the routes changing', () => {
    const context = ctx(() => null, null)
    const push = vi.fn()
    tunnelStatePart.watch?.(context, push)
    expect(context.services.tunnel.onChange).toHaveBeenCalledWith(push)
  })
})
