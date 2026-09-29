import { describe, expect, it } from 'vitest'
import { extensionOpenedUrl } from '../extension-url-policy.js'

const LOADED_ID = 'abcdefghijklmnopabcdefghijklmnop'
const isLoaded = (id: string): boolean => id === LOADED_ID

describe('extensionOpenedUrl', () => {
  it('allows http and https, normalised', () => {
    expect(extensionOpenedUrl('http://example.com', isLoaded)).toBe('http://example.com/')
    expect(extensionOpenedUrl('https://example.com/path', isLoaded)).toBe('https://example.com/path')
  })

  it('allows about:blank', () => {
    expect(extensionOpenedUrl('about:blank', isLoaded)).toBe('about:blank')
  })

  it('allows a chrome-extension: URL only for a loaded extension', () => {
    expect(extensionOpenedUrl(`chrome-extension://${LOADED_ID}/page.html`, isLoaded))
      .toBe(`chrome-extension://${LOADED_ID}/page.html`)
    expect(extensionOpenedUrl('chrome-extension://notloaded00000000000000000000/page.html', isLoaded))
      .toBeUndefined()
  })

  it('refuses file:, javascript:, data:, orivon:, chrome: and devtools:', () => {
    for (const url of [
      'file:///etc/hostname',
      'javascript:alert(1)',
      'data:text/html,hi',
      'orivon://settings',
      'chrome://version',
      'devtools://devtools/bundled/inspector.html'
    ]) {
      expect(extensionOpenedUrl(url, isLoaded)).toBeUndefined()
    }
  })

  it('refuses garbage and scheme-less input', () => {
    expect(extensionOpenedUrl('not a url', isLoaded)).toBeUndefined()
    expect(extensionOpenedUrl('example.com', isLoaded)).toBeUndefined()
    expect(extensionOpenedUrl('', isLoaded)).toBeUndefined()
  })

  it('refuses a malformed chrome-extension: URL', () => {
    expect(extensionOpenedUrl('chrome-extension://', isLoaded)).toBeUndefined()
  })
})
