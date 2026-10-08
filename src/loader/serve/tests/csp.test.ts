import { describe, expect, it } from 'vitest'
import { cspHeaderValue } from '../csp.js'

/** One directive's source list, or undefined when the header does not set it. */
function directive (header: string, name: string): string[] | undefined {
  for (const part of header.split(';')) {
    const [directiveName, ...sources] = part.trim().split(/\s+/)
    if (directiveName === name) return sources
  }
  return undefined
}

const EMPTY = cspHeaderValue([], [])

describe('cspHeaderValue -- what a pinned bundle may do with its own bytes', () => {
  it('admits eval and WebAssembly compilation, but never inline script', () => {
    expect(directive(EMPTY, 'script-src')).toEqual(["'self'", "'unsafe-eval'", "'wasm-unsafe-eval'"])
  })

  it('admits inline script only when asked, and keeps every other directive as it was', () => {
    const inline = cspHeaderValue([], [], { inlineScripts: true })
    expect(directive(inline, 'script-src')).toEqual(["'self'", "'unsafe-eval'", "'wasm-unsafe-eval'", "'unsafe-inline'"])
    expect(inline.replace(" 'unsafe-inline'", '').split('; ').filter((d) => !d.startsWith('script-src')))
      .toEqual(EMPTY.split('; ').filter((d) => !d.startsWith('script-src')))
    expect(cspHeaderValue([], [], {})).toBe(EMPTY)
  })

  it('admits data: and blob: images, fonts and media -- local schemes with no network reach', () => {
    for (const name of ['img-src', 'font-src', 'media-src']) {
      expect([name, directive(EMPTY, name)]).toEqual([name, ["'self'", 'data:', 'blob:']])
    }
  })

  it('admits fetching a data: or blob: URL', () => {
    expect(directive(EMPTY, 'connect-src')).toEqual(["'self'", 'data:', 'blob:'])
  })

  it('sets worker-src explicitly, so a blob: worker starts', () => {
    expect(directive(EMPTY, 'worker-src')).toEqual(["'self'", 'blob:'])
  })

  it('admits same-origin, data: and blob: frames, and never a third-party one', () => {
    expect(directive(EMPTY, 'frame-src')).toEqual(["'self'", 'data:', 'blob:'])
    expect(directive(cspHeaderValue([], ['cdn.example.com:443']), 'frame-src')).toEqual(["'self'", 'data:', 'blob:'])
  })

  it('keeps default-src and style-src as they were', () => {
    expect(directive(EMPTY, 'default-src')).toEqual(["'self'"])
    expect(directive(EMPTY, 'style-src')).toEqual(["'self'", "'unsafe-inline'"])
  })

  it('sets object-src to none -- default-src alone would admit a same-origin <object>/<embed> document', () => {
    expect(directive(EMPTY, 'object-src')).toEqual(["'none'"])
  })

  it('sets no form-action: it never falls back to default-src, and a restriction would break a form-post sign-in flow', () => {
    expect(directive(EMPTY, 'form-action')).toBeUndefined()
  })
})

describe('cspHeaderValue -- reach from the live grants', () => {
  const header = cspHeaderValue(['api.example.com:443'], ['cdn.example.com:443'])

  it('keeps tcp.connect\'s bare host:port sources in connect-src', () => {
    expect(directive(header, 'connect-src')).toContain('api.example.com:443')
  })

  it('adds https.connect\'s scheme-qualified sources to connect-src, the grant the reach handler checks', () => {
    expect(directive(header, 'connect-src')).toEqual(["'self'", 'data:', 'blob:', 'api.example.com:443', 'https://cdn.example.com:443'])
  })

  it('widens img-src, font-src and media-src from https.connect only, never tcp.connect', () => {
    for (const name of ['img-src', 'font-src', 'media-src']) {
      expect([name, directive(header, name)]).toEqual([name, ["'self'", 'data:', 'blob:', 'https://cdn.example.com:443']])
    }
  })

  it('never emits a ws: or wss: source for an https.connect grant', () => {
    const onlyHttps = cspHeaderValue([], ['cdn.example.com:443', 'b.example:*'])
    expect(onlyHttps).not.toMatch(/\bwss?:/)
  })

  it('a `*` https.connect grant emits the https: scheme source in the four reach directives, and nowhere else', () => {
    const anyHost = cspHeaderValue([], ['*:443'])
    for (const name of ['connect-src', 'img-src', 'font-src', 'media-src']) {
      expect([name, directive(anyHost, name)]).toEqual([name, ["'self'", 'data:', 'blob:', 'https:']])
    }
    expect(directive(anyHost, 'frame-src')).toEqual(["'self'", 'data:', 'blob:'])
    expect(directive(anyHost, 'script-src')).not.toContain('https:')
    expect(anyHost).not.toMatch(/\bwss?:/)
  })

  it('a `*` tcp.connect grant still adds nothing to connect-src (A43)', () => {
    expect(cspHeaderValue(['*:*'], [])).toBe(EMPTY)
  })
})

describe('cspHeaderValue -- media from the app\'s own loopback listener', () => {
  const LOOPBACK = ['http://localhost:*', 'http://127.0.0.1:*']

  it('adds the two loopback sources to media-src and img-src only when the app holds a listen grant', () => {
    const own = cspHeaderValue([], [], { ownListenerMedia: true })
    for (const name of ['media-src', 'img-src']) {
      expect([name, directive(own, name)]).toEqual([name, ["'self'", 'data:', 'blob:', ...LOOPBACK]])
    }
    expect(cspHeaderValue([], [], { ownListenerMedia: false })).toBe(EMPTY)
  })

  it('leaves every other directive as it was: no connect, frame, font or script reach to loopback', () => {
    const own = cspHeaderValue([], [], { ownListenerMedia: true })
    const rest = (header: string): string[] => header.split('; ').filter((d) => !d.startsWith('media-src') && !d.startsWith('img-src'))
    expect(rest(own)).toEqual(rest(EMPTY))
  })

  it('keeps the granted https reach beside the loopback sources', () => {
    const own = cspHeaderValue([], ['cdn.example.com:443'], { ownListenerMedia: true })
    expect(directive(own, 'media-src')).toEqual(["'self'", 'data:', 'blob:', ...LOOPBACK, 'https://cdn.example.com:443'])
  })
})
