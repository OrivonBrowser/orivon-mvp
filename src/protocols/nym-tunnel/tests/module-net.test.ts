import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { checkedConnector, checkedLookup, createModuleNetwork, NetworkRefused } from '../module-net.js'

function lookupReturning (...addresses: string[]) {
  return (_hostname: string, _options: unknown, callback: (error: null, found: Array<{ address: string, family: number }>) => void): void => {
    callback(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })))
  }
}

function resolveWith (...addresses: string[]) {
  const lookup = checkedLookup(lookupReturning(...addresses) as never)
  return new Promise<{ error: Error | null, found: unknown }>((resolve) => {
    lookup('gateway.example', { all: true }, (error, found) => { resolve({ error, found }) })
  })
}

describe('the checked lookup', () => {
  it('answers with the addresses of a name whose every address is public', async () => {
    const { error, found } = await resolveWith('93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946')
    expect(error).toBeNull()
    expect(found).toHaveLength(2)
  })

  it.each([['loopback', '127.0.0.1'], ['loopback v6', '::1'], ['a LAN address', '192.168.1.1'], ['a private address', '10.1.2.3'], ['link-local', '169.254.169.254'], ['carrier-grade NAT', '100.64.0.1'], ['v4 mapped into v6', '::ffff:127.0.0.1']])('refuses a name that answers %s', async (_label, address) => {
    const { error } = await resolveWith(address)
    expect(error).toBeInstanceOf(NetworkRefused)
  })

  it('refuses the whole name when only one of its addresses is private', async () => {
    const { error } = await resolveWith('93.184.216.34', '10.0.0.1')
    expect(error).toBeInstanceOf(NetworkRefused)
  })

  it('refuses a name with no address', async () => {
    const { error } = await resolveWith()
    expect(error).toBeInstanceOf(NetworkRefused)
  })
})

describe('the checked connector', () => {
  function attempt (options: { protocol?: string, hostname?: string }) {
    const dialled: unknown[] = []
    const connector = checkedConnector((dialOptions) => { dialled.push(dialOptions) })
    let refusal: Error | null = null
    connector(options, (error) => { refusal = error })
    return { dialled, refusal: () => refusal }
  }

  it('dials an https address', () => {
    expect(attempt({ protocol: 'https:', hostname: 'directory.example' }).dialled).toHaveLength(1)
    expect(attempt({ protocol: 'https:', hostname: '93.184.216.34' }).dialled).toHaveLength(1)
  })

  it('refuses a plain http dial, whatever address it is for', () => {
    const { dialled, refusal } = attempt({ protocol: 'http:', hostname: 'directory.example' })
    expect(dialled).toHaveLength(0)
    expect(refusal()).toBeInstanceOf(NetworkRefused)
  })

  it.each(['127.0.0.1', '192.168.0.10', '[::1]', '[fe80::1]', '0.0.0.0'])('refuses the literal address %s without dialling', (hostname) => {
    const { dialled, refusal } = attempt({ protocol: 'https:', hostname })
    expect(dialled).toHaveLength(0)
    expect(refusal()).toBeInstanceOf(NetworkRefused)
  })
})

describe('the module network', () => {
  it('reaches nothing on loopback: no connection arrives at a server on this computer', async () => {
    let connections = 0
    const server = createServer((socket) => { connections += 1; socket.destroy() })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as AddressInfo).port
    const network = createModuleNetwork()
    try {
      await expect(network.fetch(`https://127.0.0.1:${String(port)}/`)).rejects.toThrow()
      await expect(network.fetch(`http://127.0.0.1:${String(port)}/`)).rejects.toThrow()
      await expect(network.fetch(`https://localhost:${String(port)}/`)).rejects.toThrow()
      const closed = await new Promise<string>((resolve) => {
        const socket = new network.WebSocket(`wss://127.0.0.1:${String(port)}/`)
        socket.onerror = () => { resolve('error') }
        socket.onclose = () => { resolve('close') }
      })
      expect(['error', 'close']).toContain(closed)
      expect(connections).toBe(0)
    } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })

  it('passes a websocket\'s protocols on', () => {
    const network = createModuleNetwork(undefined, { fetch, WebSocket })
    const socket = new network.WebSocket('wss://127.0.0.1:1/', ['nym'])
    socket.onerror = () => {}
    expect(socket.protocol).toBe('')
    socket.close()
  })
})

describe('the module network once installed as the globals', () => {
  it('still reaches the original fetch and WebSocket, not itself', async () => {
    const original = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket }
    const calls: string[] = []
    const stand: typeof fetch = async (input) => { calls.push(String(input)); return new Response('x') }
    globalThis.fetch = stand
    try {
      const network = createModuleNetwork(undefined, undefined)
      globalThis.fetch = network.fetch
      await expect(network.fetch('https://127.0.0.1:1/')).resolves.toBeInstanceOf(Response)
      expect(calls).toEqual(['https://127.0.0.1:1/'])
    } finally {
      globalThis.fetch = original.fetch
    }
  })
})
