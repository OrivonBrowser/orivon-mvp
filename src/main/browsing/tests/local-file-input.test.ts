import { describe, expect, it } from 'vitest'
import { parseOmniboxInput, sanitizeDirectUrl } from '../omnibox.js'
import { parseLocalFileInput, sanitizeBrowserUrl, sanitizeLocalFileUrl } from '../local-file-input.js'

describe('parseLocalFileInput', () => {
  it('reads a file: URL with an empty host and keeps its query and fragment', () => {
    expect(parseLocalFileInput('file:///home/u/a.html?x=1#top', 'linux')).toBe('file:///home/u/a.html?x=1#top')
  })

  it('reads an absolute path and encodes what a URL must', () => {
    expect(parseLocalFileInput('/home/u/my notes/a b.html', 'linux')).toBe('file:///home/u/my%20notes/a%20b.html')
  })

  it('reads a Windows drive path in either slash', () => {
    expect(parseLocalFileInput('C:\\Users\\u\\a.html', 'win32')).toBe('file:///C:/Users/u/a.html')
    expect(parseLocalFileInput('D:/docs/a.html', 'win32')).toBe('file:///D:/docs/a.html')
  })

  it('trims the input', () => {
    expect(parseLocalFileInput('  /tmp/a.html \n', 'linux')).toBe('file:///tmp/a.html')
  })

  it.each([
    ['a host', 'file://server/share/a.html'],
    ['a path with two leading slashes', 'file:////server/share/a.html'],
    ['a UNC path', '\\\\server\\share\\a.html'],
    ['a relative path', 'docs/a.html'],
    ['a parent path', '../a.html'],
    ['a web address', 'https://example.com/a.html'],
    ['a search', 'how to open a file'],
    ['nothing', '   '],
    ['a path with a line break', '/tmp/a\nb.html']
  ])('refuses %s', (_name, input) => {
    expect(parseLocalFileInput(input, 'linux')).toBeNull()
    expect(parseLocalFileInput(input, 'win32')).toBeNull()
  })

  it('refuses a drive path off Windows, where it is a search', () => {
    expect(parseLocalFileInput('C:\\Users\\u\\a.html', 'linux')).toBeNull()
  })

  it('refuses a key past the length cap', () => {
    expect(parseLocalFileInput(`/${'a'.repeat(3000)}`, 'linux')).toBeNull()
  })
})

describe('sanitizeLocalFileUrl and sanitizeBrowserUrl', () => {
  it('accepts a file URL of a local path only', () => {
    expect(sanitizeLocalFileUrl('file:///home/u/a.html#x')).toBe('file:///home/u/a.html#x')
    expect(sanitizeLocalFileUrl('file://host/a.html')).toBeNull()
    expect(sanitizeLocalFileUrl('/home/u/a.html')).toBeNull()
    expect(sanitizeLocalFileUrl('javascript:alert(1)')).toBeNull()
  })

  it('adds file URLs to what sanitizeDirectUrl takes, and nothing else', () => {
    expect(sanitizeBrowserUrl('https://example.com/')).toBe('https://example.com/')
    expect(sanitizeBrowserUrl('file:///tmp/a.html')).toBe('file:///tmp/a.html')
    expect(sanitizeBrowserUrl('data:text/html,hi')).toBeNull()
    expect(sanitizeBrowserUrl('about:blank')).toBeNull()
  })

  it('leaves the two parsers the address bar and the stores share refusing file:', () => {
    expect(parseOmniboxInput('file:///tmp/a.html').kind).toBe('reject')
    expect(sanitizeDirectUrl('file:///tmp/a.html')).toBeNull()
  })
})
