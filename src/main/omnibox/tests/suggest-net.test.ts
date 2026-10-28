import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TabTunnelChoice } from '../../route/tab-tunnel.js'

const { netFetch } = vi.hoisted(() => ({ netFetch: vi.fn(async () => new Response('net')) }))
vi.mock('electron', () => ({ net: { fetch: netFetch } }))

const { suggestFetchFor } = await import('../suggest-net.js')
const { setOwnRequests } = await import('../../route/own-requests.js')

const URL_ASKED = 'https://suggest.example/complete?q=a'
const tunnel = vi.fn(async () => new Response('tunnel'))
const direct = vi.fn(async () => new Response('direct'))
const profileFetch = vi.fn((kind: string) => async () => new Response(`profile ${kind}`))

function routes (everywhere: boolean, withProfile = true): void {
  setOwnRequests({ everywhere: () => everywhere, isRouted: () => true, tunnel, direct, directSession: () => ({}), ...(withProfile ? { profileFetch } : {}) })
}
afterEach(() => { setOwnRequests(undefined); vi.clearAllMocks() })

/** Asks as the omnibox does, with the request the suggestions use, and reads what came back. */
async function ask (choice: TabTunnelChoice | undefined): Promise<string> {
  const response = await suggestFetchFor(choice)(URL_ASKED, { credentials: 'omit', redirect: 'error', referrer: '', signal: new AbortController().signal, headers: {} })
  return await new Response(response.body).text()
}

describe('how the address bar asks for suggestions', () => {
  it('through the browser\'s network stack for a tab with no choice, and for a direct one', async () => {
    routes(false)
    for (const choice of [undefined, 'direct'] as const) expect(await ask(choice)).toBe('net')
    expect(profileFetch).not.toHaveBeenCalled()
  })

  it('through the whole-browser tunnel while it is on, for a tab with no choice', async () => {
    routes(true)
    expect(await ask(undefined)).toBe('tunnel')
  })

  it('through the profile session of the tab\'s tunnel, whatever the whole browser is set to', async () => {
    for (const everywhere of [false, true]) {
      routes(everywhere)
      expect(await ask('nym')).toBe('profile nym')
      expect(await ask('socks5')).toBe('profile socks5')
    }
    expect(netFetch).not.toHaveBeenCalled()
    expect(tunnel).not.toHaveBeenCalled()
  })

  it('not at all when the tab\'s tunnel cannot be had, and never directly', async () => {
    routes(false, false)
    await expect(ask('nym')).rejects.toThrow(/tunnel/)
    expect(netFetch).not.toHaveBeenCalled()
  })
})
