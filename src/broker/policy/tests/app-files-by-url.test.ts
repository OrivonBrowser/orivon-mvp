import { describe, expect, it } from 'vitest'
import { appFileUrl, appFileVerdict, parseAppFileUrl } from '../app-files-by-url.js'
import type { AppFileRequest } from '../app-files-by-url.js'

const APP = 'https://app.example'

function request (overrides: Partial<AppFileRequest> = {}): AppFileRequest {
  return {
    document: { kind: 'web', origin: APP },
    url: `${APP}/orivon/app/.config/Posters/abc.jpg`,
    method: 'GET',
    holdsFs: true,
    ...overrides
  }
}

describe('appFileVerdict -- an app page shows its own files by URL, and nobody else does', () => {
  it('serves the confined relative path of a root-absolute URL the app page itself requests', () => {
    expect(appFileVerdict(request())).toEqual({ kind: 'serve', origin: APP, path: '.config/Posters/abc.jpg', encodedPath: '.config/Posters/abc.jpg' })
  })

  it('answers a HEAD as it answers a GET, and nothing else', () => {
    expect(appFileVerdict(request({ method: 'HEAD' })).kind).toBe('serve')
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) expect(appFileVerdict(request({ method })).kind).toBe('pass')
  })

  it('leaves a request from another origin alone, so it reaches the app host and learns nothing from Orivon', () => {
    expect(appFileVerdict(request({ document: { kind: 'web', origin: 'https://other.example' } })).kind).toBe('pass')
    expect(appFileVerdict(request({ document: { kind: 'web', origin: 'http://app.example' } })).kind).toBe('pass')
    expect(appFileVerdict(request({ document: { kind: 'web', origin: 'https://app.example:8443' } })).kind).toBe('pass')
  })

  it('leaves a request that names no web page alone', () => {
    expect(appFileVerdict(request({ document: { kind: 'unknown' } })).kind).toBe('pass')
    expect(appFileVerdict(request({ document: { kind: 'not-web' } })).kind).toBe('pass')
  })

  it('serves nothing to an origin that holds no fs grant', () => {
    expect(appFileVerdict(request({ holdsFs: false })).kind).toBe('pass')
  })

  it('serves only under the virtual root, never the root itself or a lookalike prefix', () => {
    for (const path of ['/orivon/app', '/orivon/app/', '/orivon/application/x.png', '/orivon/x.png', '/x.png', '/ORIVON/APP/x.png']) {
      expect([path, appFileVerdict(request({ url: `${APP}${path}` })).kind]).toEqual([path, 'pass'])
    }
  })

  it('ignores a query and a fragment, and decodes the path once', () => {
    expect(appFileVerdict(request({ url: `${APP}/orivon/app/a%20b/c.png?v=2#x` }))).toMatchObject({ kind: 'serve', path: 'a b/c.png' })
  })

  it('hands a traversal to the broker as the relative path it spells, which the broker then refuses', () => {
    expect(appFileVerdict(request({ url: `${APP}/orivon/app/..%2F..%2Fetc/passwd` }))).toMatchObject({ kind: 'serve', path: '../../etc/passwd' })
    expect(appFileVerdict(request({ url: `${APP}/orivon/app/a%2F..%2F..%2Fb` }))).toMatchObject({ kind: 'serve', path: 'a/../../b' })
  })

  it('refuses a path that cannot be decoded or carries a NUL, rather than guessing', () => {
    expect(appFileVerdict(request({ url: `${APP}/orivon/app/%E0%A4%A` })).kind).toBe('refuse')
    expect(appFileVerdict(request({ url: `${APP}/orivon/app/a%00.png` })).kind).toBe('refuse')
  })

  it('serves a loopback origin by the origin the broker keys it by', () => {
    expect(appFileVerdict(request({ document: { kind: 'web', origin: 'http://127.0.0.1:5000' }, url: 'http://127.0.0.1:5000/orivon/app/a.png' }))).toMatchObject({ kind: 'serve', origin: 'http://127.0.0.1:5000' })
  })

  it('leaves a non-web URL alone', () => {
    expect(appFileVerdict(request({ url: 'file:///orivon/app/a.png' })).kind).toBe('pass')
    expect(appFileVerdict(request({ url: 'not a url' })).kind).toBe('pass')
  })
})

describe('the capability URL a redirect carries', () => {
  const sign = (text: string): string => Buffer.from(`mac(${text})`).toString('hex')

  it('round-trips the origin and the encoded path', () => {
    const url = appFileUrl(APP, 'a%20b/c.png', sign)
    expect(url.startsWith('orivon-file://app/')).toBe(true)
    expect(parseAppFileUrl(url, sign)).toEqual({ origin: APP, path: 'a b/c.png' })
  })

  it('rejects a URL whose origin, path or mac was changed, or that another secret signed', () => {
    const url = appFileUrl(APP, 'a.png', sign)
    expect(parseAppFileUrl(url.replace('a.png', 'b.png'), sign)).toBeNull()
    expect(parseAppFileUrl(url.replace(encodeURIComponent(APP), encodeURIComponent('https://evil.example')), sign)).toBeNull()
    expect(parseAppFileUrl(url, (text) => sign(`x${text}`))).toBeNull()
  })

  it('rejects anything that is not the shape', () => {
    for (const url of ['orivon-file://app/', 'orivon-file://app/aa', 'orivon-file://app/aa/bb', 'https://app.example/a', 'not a url']) {
      expect([url, parseAppFileUrl(url, sign)]).toEqual([url, null])
    }
  })

  it('rejects a path that is empty after the mac and origin', () => {
    expect(parseAppFileUrl(`orivon-file://app/${sign(`${APP}\n`)}/${encodeURIComponent(APP)}/`, sign)).toBeNull()
  })
})
