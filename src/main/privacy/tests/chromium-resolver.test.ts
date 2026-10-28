import { describe, expect, it } from 'vitest'
import { checkConnect } from '../../../broker/policy/connect.js'
import { chromiumResolvers } from '../chromium-resolver.js'
import type { ChromiumResolveHost } from '../chromium-resolver.js'

type Endpoint = Awaited<ReturnType<ChromiumResolveHost>>['endpoints'][number]

const answering = (endpoints: readonly Endpoint[]): ChromiumResolveHost => async () => ({ endpoints: [...endpoints] })
const failing = (message: string): ChromiumResolveHost => async () => { throw new Error(message) }

describe('chromiumResolvers: the broker\'s names resolved by Chromium', () => {
  it('hands the dial every address in the order Chromium answered, without sorting or reducing them', async () => {
    const { resolveHost } = chromiumResolvers(answering([
      { address: '2606:4700::6810:84e5', family: 'ipv6' },
      { address: '104.16.132.229', family: 'ipv4' },
      { address: '104.16.133.229', family: 'ipv4' }
    ]))
    expect(await resolveHost('example.com')).toEqual(['2606:4700::6810:84e5', '104.16.132.229', '104.16.133.229'])
  })

  it('asks Chromium for the very name it was given', async () => {
    const asked: string[] = []
    const { resolveHost, resolveLookup } = chromiumResolvers(async (host) => { asked.push(host); return { endpoints: [{ address: '9.9.9.9', family: 'ipv4' }] } })
    await resolveHost('one.example')
    await resolveLookup('two.example')
    expect(asked).toEqual(['one.example', 'two.example'])
  })

  it('maps Chromium\'s families to the contract\'s, keeping order', async () => {
    const { resolveLookup } = chromiumResolvers(answering([
      { address: '2001:db8::1', family: 'ipv6' },
      { address: '203.0.113.7', family: 'ipv4' }
    ]))
    expect(await resolveLookup('example.com')).toEqual([
      { address: '2001:db8::1', family: 'IPv6' },
      { address: '203.0.113.7', family: 'IPv4' }
    ])
  })

  it('reads the family of an "unspec" answer from the address itself, and drops what is not an address', async () => {
    const { resolveHost, resolveLookup } = chromiumResolvers(answering([
      { address: '203.0.113.7', family: 'unspec' },
      { address: '2001:db8::1', family: 'unspec' },
      { address: 'not-an-address', family: 'unspec' }
    ]))
    expect(await resolveHost('example.com')).toEqual(['203.0.113.7', '2001:db8::1'])
    expect(await resolveLookup('example.com')).toEqual([
      { address: '203.0.113.7', family: 'IPv4' },
      { address: '2001:db8::1', family: 'IPv6' }
    ])
  })

  it('answers "unreachable" when Chromium finds no address, for the dial and the lookup alike', async () => {
    const { resolveHost, resolveLookup } = chromiumResolvers(answering([]))
    await expect(resolveHost('gone.example')).rejects.toMatchObject({ code: 'unreachable', message: 'could not resolve gone.example' })
    await expect(resolveLookup('gone.example')).rejects.toMatchObject({ code: 'unreachable', message: 'could not resolve gone.example' })
  })

  it('answers "unreachable" when Chromium fails, and carries its error as the platform code', async () => {
    const { resolveHost, resolveLookup } = chromiumResolvers(failing('net::ERR_NAME_NOT_RESOLVED'))
    await expect(resolveHost('gone.example')).rejects.toMatchObject({ code: 'unreachable', message: 'could not resolve gone.example', platformCode: 'net::ERR_NAME_NOT_RESOLVED' })
    await expect(resolveLookup('gone.example')).rejects.toMatchObject({ code: 'unreachable', message: 'could not resolve gone.example' })
  })

  it('leaves the connect policy in charge of the answers: a public name Chromium resolves to loopback or a private address is still refused', async () => {
    for (const address of ['127.0.0.1', '10.0.0.5', '192.168.1.50', '169.254.169.254', '::1']) {
      const { resolveHost } = chromiumResolvers(answering([{ address, family: address.includes(':') ? 'ipv6' : 'ipv4' }]))
      for (const patterns of [['evil.example:443'], ['*:443']]) {
        const decision = await checkConnect(patterns, 'evil.example', 443, resolveHost)
        expect(decision.allowed, `${patterns.join()} -> ${address}`).toBe(false)
      }
    }
  })

  it('still lets a name Chromium resolves to a public address through the same policy', async () => {
    const { resolveHost } = chromiumResolvers(answering([{ address: '104.16.132.229', family: 'ipv4' }]))
    const decision = await checkConnect(['api.example.com:443'], 'api.example.com', 443, resolveHost)
    expect(decision).toMatchObject({ allowed: true, addresses: ['104.16.132.229'] })
  })
})

describe('chromiumResolvers: an onion name', () => {
  it('is refused before Chromium is asked, so no resolver hears of it', async () => {
    const asked: string[] = []
    const { resolveHost, resolveLookup } = chromiumResolvers(async (host) => { asked.push(host); return { endpoints: [{ address: '127.0.0.1', family: 'ipv4' }] } })
    for (const name of ['abc.onion', 'ABC.ONION.']) {
      await expect(resolveHost(name), name).rejects.toMatchObject({ code: 'unreachable', message: expect.stringContaining('opens only through a Tor tunnel') })
      await expect(resolveLookup(name), name).rejects.toMatchObject({ code: 'unreachable' })
    }
    expect(asked).toEqual([])
  })
})

