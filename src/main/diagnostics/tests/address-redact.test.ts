import { describe, expect, it } from 'vitest'
import { redactAddresses } from '../address-redact.js'

describe('redactAddresses', () => {
  it('cuts the line Electron prints for a failed load to the scheme and the kind of site, keeping the error name', () => {
    const line = '2026-11-10T23:46:50.823Z ERROR (node:2722343) electron: Failed to load URL: https://bank.example/account/12345?token=abc#top with error: ERR_NAME_NOT_RESOLVED'
    expect(redactAddresses(line)).toBe('2026-11-10T23:46:50.823Z ERROR (node:2722343) electron: Failed to load URL: https://••••.example/•••• with error: ERR_NAME_NOT_RESOLVED')
  })

  it('keeps the scheme and drops the host, the port, the path, the query and the fragment', () => {
    expect(redactAddresses('https://www.example.org/a/b.html')).toBe('https://••••.org/••••')
    expect(redactAddresses('https://example.org:8443/a')).toBe('https://••••.org/••••')
    expect(redactAddresses('https://example.org?q=secret')).toBe('https://••••.org/••••')
    expect(redactAddresses('https://example.org#section-with-a-name')).toBe('https://••••.org/••••')
    expect(redactAddresses('wss://chat.example.org/socket?room=7')).toBe('wss://••••.org/••••')
  })

  it('drops credentials in an address', () => {
    expect(redactAddresses('ftp://ann:hunter2@files.example:21/pub')).toBe('ftp://••••.example/••••')
    expect(redactAddresses('https://ann@example.org')).toBe('https://••••.org')
  })

  it('names no site of the networks Orivon opens: IPFS, ENS, Swarm and onion keep only their kind', () => {
    expect(redactAddresses('opening ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/private/notes.html')).toBe('opening ipfs://••••/••••')
    expect(redactAddresses('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')).toBe('ipfs://••••')
    expect(redactAddresses('ipns://k51qzi5uqu5dgutdk6i1ynyzgkqngpha5xpgia3a5qqp4jsh0u4csozksxel/a')).toBe('ipns://••••/••••')
    expect(redactAddresses('no proof for https://vitalik.eth/blog/2026/post.html?ref=x')).toBe('no proof for https://••••.eth/••••')
    expect(redactAddresses('refused http://exampleonionaddressexampleonionaddressexampleonionaddre.onion/forum?id=7')).toBe('refused http://••••.onion/••••')
    expect(redactAddresses('bzz://ca829811571209a7ea6e5cf6fa59f5cc1dc7ed8a7c4a9f1e0c7d3f1fbb7a0001/img.png')).toBe('bzz://••••/••••')
    expect(redactAddresses('https://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.ipfs.localhost:8080/x')).toBe('https://••••.localhost/••••')
  })

  it('names no address of a network, and no key-like last label', () => {
    expect(redactAddresses('http://192.168.1.20:8080/admin')).toBe('http://••••/••••')
    expect(redactAddresses('http://[2001:db8::1]:80/p')).toBe('http://••••/••••')
    expect(redactAddresses('https://shop.k51qzi5uqu5dgutdk6i1ynyzgkqngpha5xpgia3a5qqp4jsh0u4csozksxel/x')).toBe('https://••••/••••')
  })

  it('keeps this computer\'s own host and port, which say which local service failed', () => {
    expect(redactAddresses('http://127.0.0.1:41234/x?y=1')).toBe('http://127.0.0.1:41234/••••')
    expect(redactAddresses('http://localhost:3000')).toBe('http://localhost:3000')
    expect(redactAddresses('http://[::1]:8080/p')).toBe('http://[::1]:8080/••••')
  })

  it('keeps the name of a page Orivon draws itself, and cuts the rest of its address', () => {
    expect(redactAddresses('orivon://settings')).toBe('orivon://settings')
    expect(redactAddresses('orivon://settings/privacy?q=1')).toBe('orivon://settings/••••')
    expect(redactAddresses('orivon-shell://renderer/index.html')).toBe('orivon-shell://renderer/••••')
  })

  it('names no path of a file address, which has no site', () => {
    expect(redactAddresses('load file:///Users/bob/Documents/taxes-2025.html failed')).toBe('load file:///•••• failed')
    expect(redactAddresses('load file://~/Documents/taxes.html failed')).toBe('load file:///•••• failed')
    expect(redactAddresses('load file:///C:/Users/Bob/Desktop/a.html')).toBe('load file:///••••')
    expect(redactAddresses('at open (file:///opt/app/out/main/index.js:12:3)')).toBe('at open (file:///••••)')
  })

  it('cuts every address of a line, and the ones in quotes and brackets', () => {
    expect(redactAddresses('a widget did not load: Error: ERR_NAME_NOT_RESOLVED (-105) loading \'https://site.example/widgets/weather.html\'')).toBe('a widget did not load: Error: ERR_NAME_NOT_RESOLVED (-105) loading \'https://••••.example/••••\'')
    expect(redactAddresses('{"url":"https://a.example/x","from":"http://b.example/y?z"}')).toBe('{"url":"https://••••.example/••••","from":"http://••••.example/••••"}')
    expect(redactAddresses('from <https://a.example/x> to [https://b.example/y]')).toBe('from <https://••••.example/••••> to [https://••••.example/••••]')
    expect(redactAddresses('see (https://a.example/x). Then https://b.example/y, https://c.example/z!')).toBe('see (https://••••.example/••••). Then https://••••.example/••••, https://••••.example/••••!')
  })

  it('does not leave the end of an address that has brackets of its own', () => {
    expect(redactAddresses('https://en.example/wiki/Page_(disambiguation)_tail')).toBe('https://••••.example/••••')
  })

  it('finds an address after another scheme, as a blob or a view-source address has one', () => {
    expect(redactAddresses('blob:https://example.org/6f1c-uuid')).toBe('blob:https://••••.org/••••')
    expect(redactAddresses('view-source:HTTPS://Example.org/Path')).toBe('view-source:HTTPS://••••.org/••••')
  })

  it('leaves text that is no address', () => {
    expect(redactAddresses('2026-11-10T23:46:50.823Z WARN [verifier] 4 mounts, 12 ms, ipfs.example answered 502 on /ipfs/bafy/x')).toBe('2026-11-10T23:46:50.823Z WARN [verifier] 4 mounts, 12 ms, ipfs.example answered 502 on /ipfs/bafy/x')
    expect(redactAddresses('listening on ://nothing and https:// alone')).toBe('listening on ://nothing and https:// alone')
    expect(redactAddresses('')).toBe('')
  })

  it('changes nothing in a second pass, so an address cut elsewhere stays as it was cut', () => {
    for (const line of ['https://mainnet.infura.io/••••', 'ERROR https://a.example/x?y=1 and file:///home/ann/x', 'http://[::1]:8080/p', 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/x', 'http://abc.onion', 'orivon://settings/a']) {
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
