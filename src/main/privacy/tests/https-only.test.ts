import { describe, expect, it } from 'vitest'
import { isLocalOrPrivateHost, upgradeTarget } from '../https-only.js'

const none = (): boolean => false

describe('upgradeTarget', () => {
  it('upgrades a plain http address, keeping path, query and fragment', () => {
    expect(upgradeTarget('http://example.com/a/b?q=1#top', none)).toBe('https://example.com/a/b?q=1#top')
  })

  it('leaves a named host with an explicit port alone, since port 443 is usually another service', () => {
    expect(upgradeTarget('http://example.com:8080/x', none)).toBeNull()
    expect(upgradeTarget('http://example.com:80/x', none)).toBe('https://example.com/x')
  })

  it('keeps a public IP address\'s own port', () => {
    expect(upgradeTarget('http://8.8.8.8:8443/x', none)).toBe('https://8.8.8.8:8443/x')
    expect(upgradeTarget('http://8.8.8.8:80/x', none)).toBe('https://8.8.8.8/x')
  })

  it('leaves everything that is not http alone', () => {
    for (const url of ['https://example.com/', 'orivon://settings/', 'file:///tmp/a.html', 'ws://example.com/', 'not a url', 'about:blank']) {
      expect(upgradeTarget(url, none)).toBeNull()
    }
  })

  it('exempts loopback, in every spelling', () => {
    for (const url of ['http://127.0.0.1:8000/', 'http://127.8.9.10/', 'http://localhost:3000/', 'http://app.localhost/', 'http://LOCALHOST./', 'http://[::1]:8000/']) {
      expect(upgradeTarget(url, none)).toBeNull()
    }
  })

  it('exempts private and link-local addresses', () => {
    for (const url of ['http://10.0.0.5/', 'http://192.168.1.20:8080/', 'http://172.16.0.1/', 'http://172.31.255.1/', 'http://169.254.10.10/', 'http://0.0.0.0/', 'http://[fd12:3456::1]/', 'http://[fe80::1]/', 'http://[::ffff:192.168.0.1]/']) {
      expect(upgradeTarget(url, none)).toBeNull()
    }
  })

  it('upgrades the public addresses next to the private ranges', () => {
    for (const url of ['http://172.15.0.1/', 'http://172.32.0.1/', 'http://192.169.0.1/', 'http://11.0.0.1/', 'http://[2606:4700::1111]/']) {
      expect(upgradeTarget(url, none)).not.toBeNull()
    }
  })

  it('exempts single-label names and a network\'s own suffixes', () => {
    for (const url of ['http://router/', 'http://printer.local/', 'http://nas.lan/', 'http://wiki.internal/', 'http://gateway.home.arpa/', 'http://host.localdomain/']) {
      expect(upgradeTarget(url, none)).toBeNull()
    }
  })

  it('exempts the names a protocol routes to the verifier', () => {
    expect(upgradeTarget('http://vitalik.eth/', none)).toBeNull()
    expect(upgradeTarget('http://abc.ipfs.orivon/', none)).toBeNull()
  })

  it('exempts what the caller names, by host only', () => {
    const exempt = (host: string): boolean => host === 'kept.example'
    expect(upgradeTarget('http://kept.example:9000/x', exempt)).toBeNull()
    expect(upgradeTarget('http://other.example/x', exempt)).toBe('https://other.example/x')
  })

  it('gives the exemption the host as the URL parser normalises it', () => {
    const seen: string[] = []
    upgradeTarget('http://Mixed.Example./x', (host) => { seen.push(host); return false })
    expect(seen).toEqual(['mixed.example'])
  })
})

describe('isLocalOrPrivateHost', () => {
  it('is false for a public name', () => {
    expect(isLocalOrPrivateHost('example.com')).toBe(false)
    expect(isLocalOrPrivateHost('localhost.example.com')).toBe(false)
  })

  it('is true for the names routers and companies use that were never public: .home, .corp, .intranet, .private', () => {
    for (const host of ['router.home', 'wiki.corp', 'portal.intranet', 'nas.private', 'printer.lan']) expect(isLocalOrPrivateHost(host), host).toBe(true)
    expect(isLocalOrPrivateHost('home.example.com')).toBe(false)
  })

  it('is not fooled by a number that is not an address', () => {
    expect(isLocalOrPrivateHost('10.0.0.256')).toBe(false)
  })
})
