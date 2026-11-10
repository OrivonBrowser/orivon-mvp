import { describe, expect, it } from 'vitest'
import { redactAddresses } from '../address-redact.js'

describe('redactAddresses', () => {
  it('cuts the line Electron prints for a failed load after its site, keeping the error name', () => {
    const line = '2026-11-10T23:46:50.823Z ERROR (node:2722343) electron: Failed to load URL: https://bank.example/account/12345?token=abc#top with error: ERR_NAME_NOT_RESOLVED'
    expect(redactAddresses(line)).toBe('2026-11-10T23:46:50.823Z ERROR (node:2722343) electron: Failed to load URL: https://bank.example/•••• with error: ERR_NAME_NOT_RESOLVED')
  })

  it('keeps the scheme, the site and its port, and drops the path, the query and the fragment', () => {
    expect(redactAddresses('https://example.org/a/b.html')).toBe('https://example.org/••••')
    expect(redactAddresses('http://127.0.0.1:41234/x?y=1')).toBe('http://127.0.0.1:41234/••••')
    expect(redactAddresses('https://example.org?q=secret')).toBe('https://example.org/••••')
    expect(redactAddresses('https://example.org#section-with-a-name')).toBe('https://example.org/••••')
    expect(redactAddresses('http://[::1]:8080/p')).toBe('http://[::1]:8080/••••')
  })

  it('drops credentials in an address', () => {
    expect(redactAddresses('ftp://ann:hunter2@files.example:21/pub')).toBe('ftp://files.example:21/••••')
    expect(redactAddresses('https://ann@example.org')).toBe('https://example.org')
  })

  it('cuts the addresses of the networks Orivon opens: IPFS, ENS, Swarm and onion', () => {
    expect(redactAddresses('opening ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/private/notes.html')).toBe('opening ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/••••')
    expect(redactAddresses('no proof for https://vitalik.eth/blog/2026/post.html?ref=x')).toBe('no proof for https://vitalik.eth/••••')
    expect(redactAddresses('ipns://k51qzi5uqu5dgutdk6i1ynyzgkqngpha5xpgia3a5qqp4jsh0u4csozksxel/a')).toBe('ipns://k51qzi5uqu5dgutdk6i1ynyzgkqngpha5xpgia3a5qqp4jsh0u4csozksxel/••••')
    expect(redactAddresses('refused http://exampleonionaddressexampleonionaddressexampleonionaddre.onion/forum?id=7')).toBe('refused http://exampleonionaddressexampleonionaddressexampleonionaddre.onion/••••')
    expect(redactAddresses('bzz://ca829811571209a7ea6e5cf6fa59f5cc1dc7ed8a7c4a9f1e0c7d3f1fbb7a0001/img.png')).toBe('bzz://ca829811571209a7ea6e5cf6fa59f5cc1dc7ed8a7c4a9f1e0c7d3f1fbb7a0001/••••')
  })

  it('names no path of a file address, which has no site', () => {
    expect(redactAddresses('load file:///Users/bob/Documents/taxes-2025.html failed')).toBe('load file:///•••• failed')
    expect(redactAddresses('load file://~/Documents/taxes.html failed')).toBe('load file://~/•••• failed')
    expect(redactAddresses('load file:///C:/Users/Bob/Desktop/a.html')).toBe('load file:///••••')
    expect(redactAddresses('at open (file:///opt/app/out/main/index.js:12:3)')).toBe('at open (file:///••••)')
  })

  it('cuts every address of a line, and the ones in quotes and brackets', () => {
    expect(redactAddresses('a widget did not load: Error: ERR_NAME_NOT_RESOLVED (-105) loading \'https://site.example/widgets/weather.html\'')).toBe('a widget did not load: Error: ERR_NAME_NOT_RESOLVED (-105) loading \'https://site.example/••••\'')
    expect(redactAddresses('{"url":"https://a.example/x","from":"http://b.example/y?z"}')).toBe('{"url":"https://a.example/••••","from":"http://b.example/••••"}')
    expect(redactAddresses('from <https://a.example/x> to [https://b.example/y]')).toBe('from <https://a.example/••••> to [https://b.example/••••]')
    expect(redactAddresses('see (https://a.example/x). Then https://b.example/y, https://c.example/z!')).toBe('see (https://a.example/••••). Then https://b.example/••••, https://c.example/••••!')
  })

  it('does not leave the end of an address that has brackets of its own', () => {
    expect(redactAddresses('https://en.example/wiki/Page_(disambiguation)_tail')).toBe('https://en.example/••••')
  })

  it('finds an address after another scheme, as a blob or a view-source address has one', () => {
    expect(redactAddresses('blob:https://example.org/6f1c-uuid')).toBe('blob:https://example.org/••••')
    expect(redactAddresses('view-source:HTTPS://Example.org/Path')).toBe('view-source:HTTPS://Example.org/••••')
  })

  it('leaves an address with nothing after its site, and text that is no address', () => {
    expect(redactAddresses('https://example.org')).toBe('https://example.org')
    expect(redactAddresses('https://example.org/')).toBe('https://example.org/')
    expect(redactAddresses('orivon://settings')).toBe('orivon://settings')
    expect(redactAddresses('2026-11-10T23:46:50.823Z WARN [verifier] 4 mounts, 12 ms, ipfs.example answered 502 on /ipfs/bafy/x')).toBe('2026-11-10T23:46:50.823Z WARN [verifier] 4 mounts, 12 ms, ipfs.example answered 502 on /ipfs/bafy/x')
    expect(redactAddresses('listening on ://nothing and https:// alone')).toBe('listening on ://nothing and https:// alone')
    expect(redactAddresses('')).toBe('')
  })

  it('changes nothing in a second pass, so an address cut elsewhere stays as it was cut', () => {
    for (const line of ['https://mainnet.infura.io/••••', 'ERROR https://a.example/x?y=1 and file:///home/ann/x', 'http://[::1]:8080/p']) {
      const once = redactAddresses(line)
      expect(redactAddresses(once)).toBe(once)
    }
  })

  it('stays fast on a long run of scheme characters', () => {
    const started = Date.now()
    redactAddresses(`${'a.'.repeat(1000)}b`)
    expect(Date.now() - started).toBeLessThan(500)
  })
})
