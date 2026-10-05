import { describe, expect, it } from 'vitest'
import { ETH_GATEWAY_SUFFIXES, ethGatewayTarget } from '../eth-gateway.js'

const never = (): boolean => false

describe('ethGatewayTarget', () => {
  it('maps a gateway address to the .eth name, keeping the path, query and fragment', () => {
    expect(ethGatewayTarget('https://vitalik.eth.limo/a/b?x=1#h', never)).toBe('https://vitalik.eth/a/b?x=1#h')
  })

  it('lowercases the host and upgrades http to https', () => {
    expect(ethGatewayTarget('http://Vitalik.ETH.limo', never)).toBe('https://vitalik.eth/')
  })

  it('keeps every label of a subdomain name', () => {
    expect(ethGatewayTarget('https://app.uniswap.eth.limo/', never)).toBe('https://app.uniswap.eth/')
  })

  it('treats eth.link the same as eth.limo', () => {
    expect(ethGatewayTarget('https://vitalik.eth.link/x?y=2', never)).toBe('https://vitalik.eth/x?y=2')
    expect(ETH_GATEWAY_SUFFIXES).toEqual(['eth.limo', 'eth.link'])
  })

  it('keeps http for a developer-mode name', () => {
    expect(ethGatewayTarget('https://dev.eth.limo/p', (name) => name === 'dev.eth')).toBe('http://dev.eth/p')
  })

  it('drops userinfo', () => {
    expect(ethGatewayTarget('https://user:pw@vitalik.eth.limo/', never)).toBe('https://vitalik.eth/')
  })

  it('leaves every address that is not a name on the gateway alone', () => {
    const left = [
      'https://eth.limo/', 'https://www.eth.limo/', 'https://dns.eth.limo/dns-query', 'https://dns.eth.link/',
      'https://vitalik.eth.limo:8443/', 'https://xn--n3h.eth.limo/', 'https://vitalik.limo/',
      'https://vitalik.eth.limo.evil.example/', 'https://evil-eth.limo/', 'https://vitalik.eth.limo./',
      'ftp://vitalik.eth.limo/', 'not a url', '', 'https://sub.xn--n3h.eth.link/'
    ]
    for (const url of left) expect(ethGatewayTarget(url, never), url).toBeUndefined()
  })

  it('never maps its own result again', () => {
    const target = ethGatewayTarget('https://vitalik.eth.limo/', never)
    expect(target).toBeDefined()
    expect(ethGatewayTarget(target ?? '', never)).toBeUndefined()
  })
})
