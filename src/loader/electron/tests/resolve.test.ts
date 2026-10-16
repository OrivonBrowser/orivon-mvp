import { afterEach, describe, expect, it } from 'vitest'
import { setOwnRequests } from '../../../main/route/own-requests.js'
import { electronResolveHost } from '../resolve.js'

afterEach(() => { setOwnRequests(undefined) })

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
