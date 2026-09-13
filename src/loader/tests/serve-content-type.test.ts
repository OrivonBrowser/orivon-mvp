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
