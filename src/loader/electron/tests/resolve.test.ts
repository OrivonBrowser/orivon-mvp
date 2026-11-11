import { afterEach, describe, expect, it, vi } from 'vitest'
import { installRelayCallers } from '../../../main/route/name-relay/pinned-endpoint.js'
import { setOwnRequests } from '../../../main/route/own-requests.js'

const resolveHost = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ net: { resolveHost } }))

const { electronResolveHost } = await import('../resolve.js')

afterEach(() => { setOwnRequests(undefined); installRelayCallers(undefined); resolveHost.mockReset() })

describe('electronResolveHost.atFarEnd', () => {
  const world = (everywhere: boolean): void => {
    setOwnRequests({
      everywhere: () => everywhere,
      isRouted: () => true,
      tunnel: async () => new Response(''),
      direct: async () => new Response(''),
      directSession: () => ({}),
      siteTunnelled: (origin) => origin === 'https://picked.example'
    })
  }

  it('names a website with a tunnel of its own as resolved at the far end, whatever the browser-wide setting says', () => {
    world(false)
    expect(electronResolveHost.atFarEnd?.('https://picked.example')).toBe(true)
    expect(electronResolveHost.atFarEnd?.('https://plain.example')).toBe(false)
    world(true)
    expect(electronResolveHost.atFarEnd?.('https://picked.example')).toBe(true)
  })

  it('names nothing as resolved at the far end before routes run', () => {
    expect(electronResolveHost.atFarEnd?.('https://picked.example')).toBe(false)
  })
})

describe('electronResolveHost', () => {
  it('asks Chromium\'s resolver for a name while the name relay is not running', async () => {
    resolveHost.mockResolvedValue({ endpoints: [{ address: '93.184.216.34', family: 'ipv4' }] })
    expect(await electronResolveHost('cdn.example')).toEqual(['93.184.216.34'])
    expect(resolveHost).toHaveBeenCalledExactlyOnceWith('cdn.example')
  })

  it('asks the relay\'s lookup, and never this computer\'s resolver, while the name relay runs', async () => {
    const lookup = vi.fn(async () => ['93.184.216.34', '2606:2800:220:1::1'])
    installRelayCallers({ lookup, systemAnswer: async () => 'PROXY 127.0.0.1:3128' })
    resolveHost.mockResolvedValue({ endpoints: [{ address: '10.0.0.5', family: 'ipv4' }] })
    expect(await electronResolveHost('cdn.example')).toEqual(['93.184.216.34', '2606:2800:220:1::1'])
    expect(lookup).toHaveBeenCalledExactlyOnceWith('cdn.example', 'https://cdn.example/')
    expect(resolveHost).not.toHaveBeenCalled()
  })

  it('fails the way the relay\'s lookup does, with no fallback to this computer\'s resolver', async () => {
    installRelayCallers({ lookup: async () => { throw new Error('not-found') }, systemAnswer: async () => 'PROXY 127.0.0.1:3128' })
    resolveHost.mockResolvedValue({ endpoints: [{ address: '93.184.216.34', family: 'ipv4' }] })
    await expect(electronResolveHost('nowhere.example')).rejects.toThrow('not-found')
    expect(resolveHost).not.toHaveBeenCalled()
  })
})
