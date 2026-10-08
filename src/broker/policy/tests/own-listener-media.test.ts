import { describe, expect, it } from 'vitest'
import { isLoopbackUrl, ownListenerMediaVerdict, requestingDocumentOf } from '../own-listener-media.js'
import type { FrameLike, OwnListenerMediaRequest } from '../own-listener-media.js'

const APP = 'https://app.example'

function request (overrides: Partial<OwnListenerMediaRequest> = {}): OwnListenerMediaRequest {
  return {
    document: { kind: 'web', origin: APP },
    url: 'http://localhost:5000/0/movie.mp4',
    holdsListenGrant: true,
    holdsPort: (port) => port === 5000,
    ...overrides
  }
}

describe('isLoopbackUrl', () => {
  it.each([
    'http://localhost:1/x', 'http://LOCALHOST:1/x', 'http://localhost./x', 'http://a.localhost:1/x',
    'http://127.0.0.1:1/x', 'http://127.0.0.2:1/x', 'http://127.255.255.254/x', 'http://[::1]:1/x',
    'http://0x7f.1:1/x', 'https://127.0.0.1:1/x', 'http://[::ffff:127.0.0.1]:1/x'
  ])('%s is loopback', (url) => {
    expect(isLoopbackUrl(url)).toBe(true)
  })

  it.each([
    'http://example.com:1/x', 'http://192.168.0.1:1/x', 'http://10.0.0.1/x', 'http://localhost.example.com/x',
    'http://notlocalhost/x', 'data:image/png;base64,AAAA', 'blob:https://app.example/1', 'not a url', ''
  ])('%s is not', (url) => {
    expect(isLoopbackUrl(url)).toBe(false)
  })
})

describe('ownListenerMediaVerdict -- a page may load media from a loopback port its own listener holds, and no other', () => {
  it('allows the port the app holds, on each spelling the page policy admits', () => {
    for (const host of ['localhost', '127.0.0.1']) {
      expect(ownListenerMediaVerdict(request({ url: `http://${host}:5000/a.mp4` }))).toBe('allow')
    }
  })

  it('cancels another loopback port', () => {
    expect(ownListenerMediaVerdict(request({ url: 'http://localhost:5001/a.mp4' }))).toBe('cancel')
    expect(ownListenerMediaVerdict(request({ url: 'http://[::1]:22/a.mp4' }))).toBe('cancel')
  })

  it('cancels [::1] even on the held port: the page policy has no source for an IPv6 literal', () => {
    expect(ownListenerMediaVerdict(request({ url: 'http://[::1]:5000/a.mp4' }))).toBe('cancel')
  })

  it('cancels another address in 127.0.0.0/8 even on the held port: only the spellings the page policy admits are', () => {
    expect(ownListenerMediaVerdict(request({ url: 'http://127.0.0.2:5000/a.mp4' }))).toBe('cancel')
    expect(ownListenerMediaVerdict(request({ url: 'http://a.localhost:5000/a.mp4' }))).toBe('cancel')
    expect(ownListenerMediaVerdict(request({ url: 'http://[::ffff:127.0.0.1]:5000/a.mp4' }))).toBe('cancel')
  })

  it('reads a request with no port as the scheme default, which the app cannot hold below 1024 unless granted', () => {
    expect(ownListenerMediaVerdict(request({ url: 'http://localhost/a.mp4' }))).toBe('cancel')
    expect(ownListenerMediaVerdict(request({ url: 'http://localhost/a.mp4', holdsPort: (port) => port === 80 }))).toBe('allow')
    expect(ownListenerMediaVerdict(request({ url: 'https://localhost/a.mp4', holdsPort: (port) => port === 443 }))).toBe('allow')
  })

  it('leaves a request that is not loopback alone', () => {
    expect(ownListenerMediaVerdict(request({ url: 'https://cdn.example/a.mp4' }))).toBe('allow')
    expect(ownListenerMediaVerdict(request({ url: 'http://192.168.0.5:5000/a.mp4' }))).toBe('allow')
    expect(ownListenerMediaVerdict(request({ url: 'data:image/png;base64,AAAA' }))).toBe('allow')
  })

  it('cancels every loopback port when the app holds no listener', () => {
    expect(ownListenerMediaVerdict(request({ holdsPort: () => false }))).toBe('cancel')
  })

  it('leaves a page without a listen grant to the policy it already has', () => {
    expect(ownListenerMediaVerdict(request({ holdsListenGrant: false, holdsPort: () => false }))).toBe('allow')
  })

  it('cancels a loopback request it cannot attribute to a page', () => {
    expect(ownListenerMediaVerdict(request({ document: { kind: 'unknown' } }))).toBe('cancel')
    expect(ownListenerMediaVerdict(request({ document: { kind: 'unknown' }, holdsListenGrant: false }))).toBe('cancel')
  })

  it('leaves a page of another kind (a local file, an extension) to the policy it already has', () => {
    expect(ownListenerMediaVerdict(request({ document: { kind: 'not-web' }, holdsListenGrant: false, holdsPort: () => false }))).toBe('allow')
  })

  it('allows a page its own loopback origin', () => {
    expect(ownListenerMediaVerdict(request({ document: { kind: 'web', origin: 'http://localhost:3000' }, url: 'http://localhost:3000/a.png', holdsPort: () => false }))).toBe('allow')
    expect(ownListenerMediaVerdict(request({ document: { kind: 'web', origin: 'http://localhost:3000' }, url: 'http://localhost:3001/a.png', holdsPort: () => false }))).toBe('cancel')
  })
})

describe('requestingDocumentOf -- which page a request belongs to', () => {
  const frame = (url: string, parent: FrameLike | null = null): FrameLike => ({ url, parent })

  it('reads a web frame by its own origin', () => {
    expect(requestingDocumentOf(frame('https://app.example/page?x=1'))).toEqual({ kind: 'web', origin: 'https://app.example' })
  })

  it('gives a frame with no web address the first ancestor that has one', () => {
    const top = frame('http://127.0.0.1:3000/')
    expect(requestingDocumentOf(frame('about:blank', top))).toEqual({ kind: 'web', origin: 'http://127.0.0.1:3000' })
    expect(requestingDocumentOf(frame('about:srcdoc', frame('about:blank', top)))).toEqual({ kind: 'web', origin: 'http://127.0.0.1:3000' })
  })

  it('reads a blob frame as the origin that made it', () => {
    expect(requestingDocumentOf(frame('blob:https://app.example/4f1c'))).toEqual({ kind: 'web', origin: 'https://app.example' })
  })

  it('calls a local file, an extension page and a shell page not-web', () => {
    for (const url of ['file:///home/me/page.html', 'chrome-extension://abcdef/popup.html', 'orivon-shell://renderer/index.html']) {
      expect(requestingDocumentOf(frame(url))).toEqual({ kind: 'not-web' })
    }
  })

  it('does not attribute a request with no frame, or one whose frame throws when read', () => {
    expect(requestingDocumentOf(null)).toEqual({ kind: 'unknown' })
    expect(requestingDocumentOf(undefined)).toEqual({ kind: 'unknown' })
    const gone = { get url (): string { throw new Error('frame destroyed') }, parent: null } as FrameLike
    expect(requestingDocumentOf(gone)).toEqual({ kind: 'unknown' })
  })
})
