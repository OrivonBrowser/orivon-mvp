import { describe, expect, it } from 'vitest'
import { rendererEntryUrl, validatedDevServerUrl } from '../renderer-entry.js'
import { DEFAULT_SESSION_ENTRIES, SHELL_SESSION_ENTRIES } from '../shell-session.js'

describe('rendererEntryUrl', () => {
  it('serves an entry off the dev server at its nested path', () => {
    expect(rendererEntryUrl('http://localhost:5173', '/newtab/', 'newtab')).toBe('http://localhost:5173/newtab/')
  })

  it('names a built entry on the shell scheme, never as a file URL', () => {
    expect(rendererEntryUrl(undefined, '/', 'index')).toBe('orivon-shell://renderer/index.html')
    expect(rendererEntryUrl(undefined, '/newtab/', 'newtab')).toBe('orivon-shell://renderer/newtab/index.html')
    for (const entry of [...SHELL_SESSION_ENTRIES, ...DEFAULT_SESSION_ENTRIES]) {
      expect(rendererEntryUrl(undefined, '/', entry)).toMatch(/^orivon-shell:\/\/renderer\/(.+\/)?index\.html$/)
    }
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
