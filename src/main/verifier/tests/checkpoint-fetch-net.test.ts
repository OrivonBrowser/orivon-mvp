import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NotFoundAnswer } from '../checkpoint-fetch.js'
import { beaconJson } from '../checkpoint-fetch-net.js'

const sent = vi.hoisted(() => ({ own: [] as string[], local: [] as string[], status: 200 }))

vi.mock('electron', () => ({
  net: { fetch: async () => new Response(sent.status === 200 ? '{"data":"own"}' : null, { status: sent.status }) }
}))

vi.mock('../../route/own-requests.js', () => ({
  ownFetch: (send: (url: string, init?: RequestInit) => Promise<Response>) => async (url: string, init?: RequestInit) => {
    sent.own.push(url)
    return await send(url, init)
  }
}))

vi.mock('../../../protocols/verifier-host/local-rpc-fetch.js', () => ({
  createLocalRpcFetch: () => async (url: string) => {
    sent.local.push(url)
    return new Response('{"data":"local"}')
  }
}))

const LOCAL = 'http://127.0.0.1:5052'
const ORIVON = 'https://ethereum-beacon-api.publicnode.com'
const FINALIZED = '/eth/v1/beacon/headers/finalized'

beforeEach(() => {
  sent.own.length = 0
  sent.local.length = 0
  sent.status = 200
})

describe('beaconJson: which fetch a request goes to', () => {
  it('sends a request under the person\'s local server to the local fetch, and never to Orivon\'s own request path', async () => {
    expect(await beaconJson(`${LOCAL}${FINALIZED}`, LOCAL)).toEqual({ data: 'local' })
    expect(sent.local).toEqual([`${LOCAL}${FINALIZED}`])
    expect(sent.own).toEqual([])
  })

  it('sends a request to any other server to Orivon\'s own request path, and never to the local fetch, whatever server is named local', async () => {
    expect(await beaconJson(`${ORIVON}${FINALIZED}`, LOCAL)).toEqual({ data: 'own' })
    expect(sent.own).toEqual([`${ORIVON}${FINALIZED}`])
    expect(sent.local).toEqual([])
  })

  it('sends everything to Orivon\'s own request path while no server is named local', async () => {
    await beaconJson(`${ORIVON}${FINALIZED}`)
    await beaconJson(`https://beacon.example.com/key${FINALIZED}`)
    expect(sent.own).toHaveLength(2)
    expect(sent.local).toEqual([])
  })
})

describe('beaconJson: what an error says', () => {
  it('names the server masked on a 404, which is an answer, and on any other status', async () => {
    sent.status = 404
    const notFound = await beaconJson('https://beacon.example.com/FAKEKEY123456/eth/v1/beacon/blocks/1/root').catch((error: unknown) => error)
    expect(notFound).toBeInstanceOf(NotFoundAnswer)
    expect((notFound as Error).message).toBe('https://beacon.example.com/•••• answered 404')
    sent.status = 500
    const failed = await beaconJson('https://beacon.example.com/FAKEKEY123456/eth/v1/beacon/blocks/1/root').catch((error: unknown) => error)
    expect((failed as Error).message).toBe('https://beacon.example.com/•••• answered 500')
  })
})
