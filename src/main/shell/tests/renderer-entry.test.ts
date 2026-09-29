import { describe, expect, it } from 'vitest'
import { rendererEntryUrl, upperDriveLetter, validatedDevServerUrl } from '../renderer-entry.js'

describe('rendererEntryUrl', () => {
  it('serves an entry off the dev server at its nested path', () => {
    expect(rendererEntryUrl('/out/main', 'http://localhost:5173', '/newtab/', '../renderer/newtab/index.html')).toBe('http://localhost:5173/newtab/')
  })

  it('resolves the built file to a file URL otherwise', () => {
    expect(rendererEntryUrl('/opt/orivon/out/main', undefined, '/', '../renderer/index.html')).toBe('file:///opt/orivon/out/renderer/index.html')
  })
})

describe('validatedDevServerUrl', () => {
  it('passes through a loopback dev server URL when unpackaged', () => {
    expect(validatedDevServerUrl(false, 'http://localhost:5173')).toBe('http://localhost:5173')
    expect(validatedDevServerUrl(false, 'http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173')
  })

  it('returns undefined when nothing is set', () => {
    expect(validatedDevServerUrl(false, undefined)).toBeUndefined()
  })

  it('rejects it outright on a packaged build, whatever it names', () => {
    expect(validatedDevServerUrl(true, 'http://localhost:5173')).toBeUndefined()
  })

  it('rejects a non-loopback host', () => {
    expect(validatedDevServerUrl(false, 'http://example.com:5173')).toBeUndefined()
    expect(validatedDevServerUrl(false, 'http://evil.localhost:5173')).toBeUndefined()
  })

  it('rejects a scheme other than http', () => {
    expect(validatedDevServerUrl(false, 'https://localhost:5173')).toBeUndefined()
    expect(validatedDevServerUrl(false, 'file:///etc/passwd')).toBeUndefined()
  })

  it('rejects a value that does not parse as a URL', () => {
    expect(validatedDevServerUrl(false, 'not a url')).toBeUndefined()
  })
})

describe('upperDriveLetter', () => {
  it('writes a Windows drive letter the way Chromium reports it', () => {
    expect(upperDriveLetter('file:///c:/Users/x/out/renderer/index.html')).toBe('file:///C:/Users/x/out/renderer/index.html')
  })

  it('leaves an upper-case drive, a POSIX path and a non-file URL alone', () => {
    expect(upperDriveLetter('file:///D:/a/index.html')).toBe('file:///D:/a/index.html')
    expect(upperDriveLetter('file:///opt/c:/index.html')).toBe('file:///opt/c:/index.html')
    expect(upperDriveLetter('http://localhost:5173/')).toBe('http://localhost:5173/')
  })
})
