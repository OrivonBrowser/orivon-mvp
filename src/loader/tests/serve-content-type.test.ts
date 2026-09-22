import { describe, expect, it } from 'vitest'
import { contentTypeFor, DEFAULT_CONTENT_TYPE } from '../serve-content-type.js'

describe('contentTypeFor', () => {
  it('maps a known extension to its Content-Type', () => {
    expect(contentTypeFor('/index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('/app.js')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('/styles.css')).toBe('text/css; charset=utf-8')
    expect(contentTypeFor('/logo.svg')).toBe('image/svg+xml')
    expect(contentTypeFor('/font.woff2')).toBe('font/woff2')
    expect(contentTypeFor('/module.wasm')).toBe('application/wasm')
  })

  it('maps the web-app, audio, subtitle, streaming-manifest and archive types a real bundle ships', () => {
    const expected: Record<string, string> = {
      '/manifest.webmanifest': 'application/manifest+json',
      '/hero.avif': 'image/avif',
      '/legacy.cjs': 'text/javascript; charset=utf-8',
      '/a.mp3': 'audio/mpeg',
      '/a.ogg': 'audio/ogg',
      '/a.oga': 'audio/ogg',
      '/a.opus': 'audio/ogg',
      '/a.wav': 'audio/wav',
      '/a.flac': 'audio/flac',
      '/a.m4a': 'audio/mp4',
      '/a.aac': 'audio/aac',
      '/captions.vtt': 'text/vtt; charset=utf-8',
      '/icons.eot': 'application/vnd.ms-fontobject',
      '/splash.bmp': 'image/bmp',
      '/stream.m3u8': 'application/vnd.apple.mpegurl',
      '/stream.mpd': 'application/dash+xml',
      '/notes.txt': 'text/plain; charset=utf-8',
      '/feed.xml': 'application/xml',
      '/doc.pdf': 'application/pdf',
      '/export.zip': 'application/zip'
    }
    for (const [path, type] of Object.entries(expected)) expect([path, contentTypeFor(path)]).toEqual([path, type])
  })

  it('leaves .ts unmapped: it is TypeScript source in one bundle and an MPEG transport-stream segment in another', () => {
    expect(contentTypeFor('/segment0.ts')).toBe(DEFAULT_CONTENT_TYPE)
  })

  it('is case-insensitive on the extension', () => {
    expect(contentTypeFor('/INDEX.HTML')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('/Photo.JPG')).toBe('image/jpeg')
  })

  it('is conservative (DEFAULT_CONTENT_TYPE) for an unrecognised extension, never guessing something executable', () => {
    expect(contentTypeFor('/data.unknownext')).toBe(DEFAULT_CONTENT_TYPE)
    expect(DEFAULT_CONTENT_TYPE).toBe('application/octet-stream')
  })

  it('is conservative for a path with no extension at all', () => {
    expect(contentTypeFor('/README')).toBe(DEFAULT_CONTENT_TYPE)
  })

  it('is conservative for a path whose real extension is itself percent-encoded -- the raw canonical path never literally ends in ".js"', () => {
    // '/evil%2Ejs' decodes to '/evil.js' on disk, but the extension lookup
    // here works on the RAW canonical path, exactly as serve-content-
    // type.ts's own header requires: this must not read as executable.
    expect(contentTypeFor('/evil%2Ejs')).toBe(DEFAULT_CONTENT_TYPE)
  })

  it('uses the LAST dot for a multi-dot filename', () => {
    expect(contentTypeFor('/bundle.min.js')).toBe('text/javascript; charset=utf-8')
  })
})
