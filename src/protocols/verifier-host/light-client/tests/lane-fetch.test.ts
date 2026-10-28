import { describe, expect, it } from 'vitest'
import { EgressRefused } from '../../egress.js'
import type { WebFetch } from '../../egress.js'
import type { LightClientConfig } from '../../protocol.js'
import { lightClientFetch } from '../lane-fetch.js'

const CHECKPOINT = `0x${'ab'.repeat(32)}`
const REMOTE = 'https://mainnet.infura.io/v3/FAKE-KEY-0123456789'
const HOME = 'http://192.168.1.20:8545/rpc/FAKE-KEY-0123456789'
const BEACON = 'http://127.0.0.1:5052'

function world (): { remote: WebFetch, local: WebFetch, remoteAsked: string[], localAsked: string[] } {
  const remoteAsked: string[] = []
  const localAsked: string[] = []
  return {
    remoteAsked,
    localAsked,
    remote: async (url) => { remoteAsked.push(url); return new Response('remote') },
    local: async (url) => { localAsked.push(url); return new Response('local') }
  }
}

const config = (overrides: Partial<LightClientConfig> = {}): LightClientConfig => ({ executionRpcs: [REMOTE, HOME], consensusRpc: BEACON, checkpoint: CHECKPOINT, localEndpoints: [HOME, BEACON], ...overrides })

function fetchOf (given: LightClientConfig, w: ReturnType<typeof world>, local: boolean = true): WebFetch {
  const result = lightClientFetch(given, w.remote, local ? w.local : undefined, 'the light client')
  if ('off' in result) throw new Error(`refused: ${result.off}`)
  return result.send
}

describe('lightClientFetch', () => {
  it('sends a local origin to the local fetch and every other to the lane\'s fetch, and never the other way round', async () => {
    const w = world()
    const fetch = fetchOf(config(), w)
    expect(await (await fetch(REMOTE, { method: 'POST', body: '{}' })).text()).toBe('remote')
    expect(await (await fetch(HOME, { method: 'POST', body: '{}' })).text()).toBe('local')
    expect(await (await fetch(`${BEACON}/eth/v1/beacon/headers`)).text()).toBe('local')
    expect(await (await fetch(`${BEACON}/`, { method: 'HEAD' })).text()).toBe('local')
    expect(w.remoteAsked).toEqual([REMOTE])
    expect(w.localAsked).toEqual([HOME, `${BEACON}/eth/v1/beacon/headers`, `${BEACON}/`])
  })

  it('reaches no address that is not one of the servers', async () => {
    const w = world()
    const fetch = fetchOf(config(), w)
    await expect(fetch('https://elsewhere.example/')).rejects.toBeInstanceOf(EgressRefused)
    await expect(fetch('http://127.0.0.1:9999/')).rejects.toBeInstanceOf(EgressRefused)
    await expect(fetch('http://169.254.169.254/')).rejects.toBeInstanceOf(EgressRefused)
    expect(w.remoteAsked).toEqual([])
    expect(w.localAsked).toEqual([])
  })

  it('uses the lane\'s fetch alone when no server is local', async () => {
    const w = world()
    const fetch = fetchOf({ executionRpcs: ['https://eth.drpc.org'], consensusRpc: 'https://ethereum-beacon-api.publicnode.com', checkpoint: CHECKPOINT }, w, false)
    expect(await (await fetch('https://eth.drpc.org', { method: 'POST', body: '{}' })).text()).toBe('remote')
    expect(w.localAsked).toEqual([])
  })

  it('refuses to start when a server named local is not an address on this computer or a home network', () => {
    const w = world()
    for (const named of ['https://rpc.example', 'http://8.8.8.8:8545', 'http://169.254.169.254', 'http://sub.localhost:8545', 'ftp://127.0.0.1']) {
      const result = lightClientFetch(config({ executionRpcs: [named], localEndpoints: [named] }), w.remote, w.local, 'the light client')
      expect(result, named).toHaveProperty('off')
    }
  })

  it('refuses to start when a local address is among the servers but not named local, so it can not be sent the other way', () => {
    const w = world()
    const result = lightClientFetch(config({ localEndpoints: [BEACON] }), w.remote, w.local, 'the light client')
    expect(result).toHaveProperty('off')
    expect(JSON.stringify(result)).not.toContain('FAKE-KEY')
  })

  it('refuses to start when a server that is not local would be reached without TLS', () => {
    const result = lightClientFetch(config({ executionRpcs: ['http://rpc.example/v3/FAKE-KEY-0123456789', HOME] }), world().remote, world().local, 'the light client')
    expect(result).toHaveProperty('off')
    expect(JSON.stringify(result)).not.toContain('FAKE-KEY')
  })

  it('refuses to start when a server that is not named local is an address for this computer or a home network in a spelling the local check does not take, or a name that is not a public one', () => {
    const w = world()
    const notInternet = ['https://[::ffff:7f00:1]:8545/', 'https://[::ffff:c0a8:114]:8545/', 'https://localhost.:8545/', 'https://foo.localhost/', 'https://169.254.169.254/', 'https://0.0.0.0/', 'https://100.64.0.1/', 'https://[fe80::1]/', 'https://nas.local/', 'https://printer.home.arpa/', 'https://router/', 'https://vitalik.eth/', 'https://eth.drpc.org./']
    for (const server of notInternet) {
      for (const given of [{ executionRpcs: [server], consensusRpc: BEACON }, { executionRpcs: [REMOTE], consensusRpc: server }]) {
        const result = lightClientFetch({ ...given, checkpoint: CHECKPOINT, localEndpoints: [BEACON] }, w.remote, w.local, 'the light client')
        expect(result, server).toHaveProperty('off')
      }
    }
    expect(w.remoteAsked).toEqual([])
  })

  it('keeps a key out of the reason it gives for a server that is not a public address', () => {
    const result = lightClientFetch({ executionRpcs: ['https://[::ffff:7f00:1]:8545/v3/FAKE-KEY-0123456789'], consensusRpc: BEACON, checkpoint: CHECKPOINT, localEndpoints: [BEACON] }, world().remote, world().local, 'the light client')
    expect(result).toHaveProperty('off')
    expect(JSON.stringify(result)).not.toContain('FAKE-KEY')
  })

  it('starts with servers that are public addresses or public names over https', async () => {
    const w = world()
    const fetch = fetchOf({ executionRpcs: ['https://eth.drpc.org', 'https://8.8.8.8/rpc', 'https://[2606:4700:4700::1111]/rpc'], consensusRpc: 'https://ethereum-beacon-api.publicnode.com', checkpoint: CHECKPOINT }, w, false)
    expect(await (await fetch('https://8.8.8.8/rpc', { method: 'POST', body: '{}' })).text()).toBe('remote')
  })

  it('refuses to start when the host has no way to a local server', () => {
    const result = lightClientFetch(config(), world().remote, undefined, 'the light client')
    expect(result).toHaveProperty('off')
  })
})
