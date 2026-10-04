import { describe, expect, it } from 'vitest'
import { faviconHost } from '../favicon-host.js'

describe('faviconHost', () => {
  it('is the lower-cased host, with a port that is not the usual one and without a path: two servers on one machine are two sites', () => {
    expect(faviconHost('https://Docs.Example.com:8443/a/b?q=1#x')).toBe('docs.example.com:8443')
    expect(faviconHost('http://127.0.0.1:3000/')).toBe('127.0.0.1:3000')
    expect(faviconHost('http://127.0.0.1:9291/app')).not.toBe(faviconHost('http://127.0.0.1:3000/'))
    expect(faviconHost('https://docs.example.com:443/')).toBe('docs.example.com')
  })

  it('names the site of a dweb address the way the person sees it', () => {
    expect(faviconHost('ipfs://bafybeigdyrzt/readme')).toBe('bafybeigdyrzt')
    expect(faviconHost('ipns://docs.eth/')).toBe('docs.eth')
  })

  it('is null for a page history does not keep, and for what is not an address', () => {
    for (const address of ['orivon://settings/', 'file:///etc/passwd', 'about:blank', 'data:text/plain,hi', 'not a url', '']) {
      expect(faviconHost(address)).toBeNull()
    }
  })
})
