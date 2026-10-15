import { describe, expect, it } from 'vitest'
import type { DirectFetch } from '../direct-fetch.js'
import { createOutsideFetch } from '../outside-fetch.js'

function world (answers: readonly string[]) {
  const dialled: Array<{ url: string, addresses: readonly string[], body?: unknown }> = []
  const direct: DirectFetch = async (url, init, addresses) => { dialled.push({ url, addresses, body: init?.body }); return new Response('ok') }
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

  it('sends a body given as bytes as the text it is, which is what the light client\'s JSON-RPC calls are', async () => {
    const { dialled, fetch } = world(['93.184.216.34'])
    await fetch('https://rpc.example/', { method: 'POST', body: new TextEncoder().encode('{"id":1}') })
    await fetch('https://rpc.example/', { method: 'POST', body: new TextEncoder().encode('{"id":2}').buffer as ArrayBuffer })
    expect(dialled.map((entry) => entry.body)).toEqual(['{"id":1}', '{"id":2}'])
    await expect(fetch('https://rpc.example/', { method: 'POST', body: new URLSearchParams({ a: '1' }) })).rejects.toThrow(/string or bytes/)
  })

  it('refuses a name that has no address it can dial', async () => {
    await expect(world([]).fetch('https://nowhere.example/')).rejects.toThrow(/no address this computer can dial/)
  })
})
