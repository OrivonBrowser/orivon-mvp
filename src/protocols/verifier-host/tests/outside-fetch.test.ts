import { describe, expect, it } from 'vitest'
import type { DirectFetch } from '../direct-fetch.js'
import { createOutsideFetch } from '../outside-fetch.js'

function world (answers: readonly string[]) {
  const dialled: Array<{ url: string, addresses: readonly string[] }> = []
  const direct: DirectFetch = async (url, _init, addresses) => { dialled.push({ url, addresses }); return new Response('ok') }
  const asked: string[] = []
  return { dialled, asked, fetch: createOutsideFetch(direct, async (host) => { asked.push(host); return answers }) }
}

describe('the fetch that leaves outside the tunnel', () => {
  it('resolves the name itself and dials the addresses it got, in canonical spelling', async () => {
    const { dialled, asked, fetch } = world(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'])
    expect(await (await fetch('https://rpc.example/path?q=1', { method: 'POST', body: '{}' })).text()).toBe('ok')
    expect(asked).toEqual(['rpc.example'])
    expect(dialled).toEqual([{ url: 'https://rpc.example/path?q=1', addresses: ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'] }])
  })

  it('does not resolve an address given as an address', async () => {
    const { dialled, asked, fetch } = world([])
    await fetch('https://93.184.216.34/')
    expect(asked).toEqual([])
    expect(dialled[0]?.addresses).toEqual(['93.184.216.34'])
  })

  it('refuses a name that has no address it can dial', async () => {
    await expect(world([]).fetch('https://nowhere.example/')).rejects.toThrow(/no address this computer can dial/)
  })
})
