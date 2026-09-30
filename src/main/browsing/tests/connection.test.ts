import { describe, expect, it } from 'vitest'
import { connectionOf, isLoopbackHost } from '../connection.js'
import type { ConnectionInput } from '../connection.js'

const page = (url: string, extra: Partial<ConnectionInput> = {}): ConnectionInput => ({ url, displayUrl: url, appTab: false, internal: false, ...extra })

describe('connectionOf', () => {
  it('trusts live https', () => {
    expect(connectionOf(page('https://example.com/a?b=1'))).toBe('secure')
  })

  it('keeps the lock when only userinfo was stripped from the address shown', () => {
    expect(connectionOf(page('https://user:pw@example.com/', { displayUrl: 'https://example.com/' }))).toBe('secure')
  })

  it('warns about plain http to a public host, by name or address', () => {
    expect(connectionOf(page('http://example.com/'))).toBe('insecure')
    expect(connectionOf(page('http://93.184.216.34:8080/'))).toBe('insecure')
    expect(connectionOf(page('http://192.168.1.10/'))).toBe('insecure')
  })

  it('says nothing for plain http that never leaves the machine', () => {
    for (const url of ['http://localhost:5173/', 'http://app.localhost/', 'http://127.0.0.1:8080/', 'http://127.1.2.3/', 'http://[::1]:3000/']) {
      expect(connectionOf(page(url)), url).toBe('local')
    }
  })

  it('gives no lock to a gateway address shown as ipfs://, though the gateway is https', () => {
    expect(connectionOf({ url: 'https://bafy.ipfs.orivon/x', displayUrl: 'ipfs://bafy/x', appTab: false, internal: false })).toBe('none')
  })

  it('gives no lock to a host a protocol gateway serves, even when it is shown as it is loaded', () => {
    expect(connectionOf(page('https://vitalik.eth/', { served: true }))).toBe('none')
  })

  it('gives no lock to a cache-served app tab', () => {
    expect(connectionOf(page('https://app.example/', { appTab: true }))).toBe('none')
    expect(connectionOf(page('http://app.example/', { appTab: true }))).toBe('none')
  })

  it('gives nothing to the shell\'s own pages or to other schemes', () => {
    expect(connectionOf(page('https://orivon.settings/', { internal: true }))).toBe('none')
    for (const url of ['orivon://settings/', 'about:blank', 'file:///tmp/a.html', 'view-source:https://example.com/', 'data:text/html,hi', '']) {
      expect(connectionOf(page(url)), url).toBe('none')
    }
  })
})

describe('isLoopbackHost', () => {
  it('is exact about what is loopback', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('LOCALHOST')).toBe(true)
    expect(isLoopbackHost('notlocalhost')).toBe(false)
    expect(isLoopbackHost('localhost.example.com')).toBe(false)
    expect(isLoopbackHost('127.0.0.1.example.com')).toBe(false)
    expect(isLoopbackHost('128.0.0.1')).toBe(false)
  })
})
