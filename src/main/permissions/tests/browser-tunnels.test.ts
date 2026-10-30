import { describe, expect, it, vi } from 'vitest'
import { browserTunnels } from '../proxy-setup.js'

// The three settings the Browser-wide panel moves, through the same store Settings uses, and the tabs it lists.

function store (refuse: readonly string[] = []) {
  const values = new Map<string, unknown>([['network.tunnel.nodes', false]])
  const set = vi.fn((key: string, value: unknown) => {
    if (refuse.includes(key)) return { ok: false as const, reason: 'locked' as const }
    values.set(key, value)
    return { ok: true as const }
  })
  return { values, set, get: (key: string) => values.get(key) as never }
}

describe('browserTunnels', () => {
  it('saves the tunnel, whether the whole browser is on it, and whether the nodes follow, each under its own setting', () => {
    const settings = store()
    const tunnels = browserTunnels(settings, () => [])
    expect(tunnels.setKind('socks5')).toBe(true)
    expect(tunnels.setEverywhere(true)).toBe(true)
    expect(tunnels.setNodes(true)).toBe(true)
    expect(settings.set.mock.calls).toEqual([['network.route.kind', 'socks5'], ['network.tunnel.everywhere', true], ['network.tunnel.nodes', true]])
    expect(tunnels.nodes()).toBe(true)
  })

  it('says a change was not made when the settings hold it fixed', () => {
    const tunnels = browserTunnels(store(['network.route.kind', 'network.tunnel.everywhere', 'network.tunnel.nodes']), () => [])
    expect(tunnels.setKind('nym')).toBe(false)
    expect(tunnels.setEverywhere(false)).toBe(false)
    expect(tunnels.setNodes(false)).toBe(false)
  })

  it('lists the tabs it was given, read when asked', () => {
    let tabs = [{ title: 'a', choice: 'nym' as const }]
    const tunnels = browserTunnels(store(), () => tabs)
    expect(tunnels.tabs()).toEqual(tabs)
    tabs = []
    expect(tunnels.tabs()).toEqual([])
  })
})
