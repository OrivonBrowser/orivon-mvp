import { describe, expect, it } from 'vitest'
import { isLocalLiteral, maskEndpoint, maskText, secretParts } from '../endpoint-mask.js'

describe('maskEndpoint', () => {
  it('shows the host alone for an address with no path', () => {
    expect(maskEndpoint('https://eth.drpc.org')).toBe('eth.drpc.org')
    expect(maskEndpoint('https://eth.drpc.org/')).toBe('eth.drpc.org')
  })

  it('hides a path, and a query, behind dots', () => {
    expect(maskEndpoint('https://mainnet.infura.io/v3/0123456789abcdef0123456789abcdef')).toBe('mainnet.infura.io/••••')
    expect(maskEndpoint('https://lb.drpc.org/ogrpc?network=ethereum&dkey=SECRET-KEY-VALUE')).toBe('lb.drpc.org/••••')
    expect(maskEndpoint('https://rpc.example/?apikey=SECRET-KEY-VALUE')).toBe('rpc.example/••••')
  })

  it('keeps a port, and masks a local address the same way', () => {
    expect(maskEndpoint('http://127.0.0.1:8545/v3/FAKE-KEY')).toBe('127.0.0.1:8545/••••')
    expect(maskEndpoint('http://192.168.1.20:8545')).toBe('192.168.1.20:8545')
    expect(maskEndpoint('http://localhost:8545/')).toBe('localhost:8545')
  })

  it('brackets an IPv6 literal', () => {
    expect(maskEndpoint('http://[::1]:8545/key/FAKE-KEY')).toBe('[::1]:8545/••••')
    expect(maskEndpoint('http://[fd00::5]/')).toBe('[fd00::5]')
  })

  it('masks a host label that looks like a key', () => {
    expect(maskEndpoint('https://9d7c6a2b3a4e4fd9b1f1c0ffee12.eth.rpc.example.cloud')).toBe('••••.eth.rpc.example.cloud')
    expect(maskEndpoint('https://ethereum-beacon-api.publicnode.com')).toBe('ethereum-beacon-api.publicnode.com')
    expect(maskEndpoint('https://lodestar-mainnet.chainsafe.io')).toBe('lodestar-mainnet.chainsafe.io')
  })

  it('never echoes text it cannot read as an address', () => {
    expect(maskEndpoint('not a url with SECRET inside')).toBe('an address that cannot be read')
  })

  it('hides credentials in the address', () => {
    expect(maskEndpoint('https://user:SECRET@rpc.example/')).toBe('rpc.example')
  })
})

describe('secretParts', () => {
  it('names the whole address, its path and query, and what in them looks like a key', () => {
    const parts = secretParts('https://mainnet.infura.io/v3/0123456789abcdef0123456789abcdef?x=ABCDEF123456')
    expect(parts).toContain('https://mainnet.infura.io/v3/0123456789abcdef0123456789abcdef?x=ABCDEF123456')
    expect(parts).toContain('/v3/0123456789abcdef0123456789abcdef?x=ABCDEF123456')
    expect(parts).toContain('0123456789abcdef0123456789abcdef')
    expect(parts).toContain('ABCDEF123456')
  })

  it('names the key-like host label and any credentials', () => {
    const parts = secretParts('https://user:hunter2hunter2@9d7c6a2b3a4e4fd9b1f1c0ffee12.eth.rpc.example.cloud/')
    expect(parts).toContain('9d7c6a2b3a4e4fd9b1f1c0ffee12')
    expect(parts).toContain('hunter2hunter2')
    expect(parts).toContain('user')
  })

  it('names nothing for an address with no secret in it', () => {
    expect(secretParts('https://eth.drpc.org')).toEqual([])
    expect(secretParts('https://eth.drpc.org/')).toEqual([])
    expect(secretParts('http://192.168.1.20:8545')).toEqual([])
  })

  it('names nothing for text that is not an address', () => {
    expect(secretParts('nonsense')).toEqual([])
  })
})

describe('maskText', () => {
  it('replaces the address, its path and what looks like a key wherever they appear', () => {
    const url = 'https://mainnet.infura.io/v3/0123456789abcdef0123456789abcdef'
    const text = `error sending request for url (${url}): 401; path /v3/0123456789abcdef0123456789abcdef; key 0123456789abcdef0123456789abcdef`
    const masked = maskText(text, [url])
    expect(masked).not.toContain('0123456789abcdef')
    expect(masked).toContain('https://mainnet.infura.io/••••')
  })

  it('leaves text with no secret in it as it was', () => {
    expect(maskText('the light client is still syncing', ['https://eth.drpc.org'])).toBe('the light client is still syncing')
    expect(maskText('could not reach https://eth.drpc.org/', ['https://eth.drpc.org'])).toBe('could not reach https://eth.drpc.org/')
  })
})

describe('isLocalLiteral', () => {
  it('accepts localhost, loopback and private literals', () => {
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.1', '::1', '[::1]', 'fd00::5', 'fc00::1']) expect(isLocalLiteral(host), host).toBe(true)
  })

  it('refuses a public address, link-local, every other class, and any other name', () => {
    for (const host of ['8.8.8.8', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', 'fe80::1', '2606:4700::1111', 'rpc.example', 'localhost.example', 'sub.localhost', '']) expect(isLocalLiteral(host), host).toBe(false)
  })

  it('refuses a literal that is not spelled in its canonical form', () => {
    for (const host of ['127.1', '2130706433', '0x7f.0.0.1', '0177.0.0.1', '010.0.0.1', '::0001']) expect(isLocalLiteral(host), host).toBe(false)
  })
})
