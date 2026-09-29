import { describe, expect, it } from 'vitest'
import { appOrigin } from '../devtools-app-origin.js'

/** A minimal `originFromUrl` double: real origins for http(s), null otherwise -- exactly `../../broker/policy/origin.js`'s own contract, without importing it. */
function originFromUrl (url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.origin
  } catch {
    return null
  }
}

describe('appOrigin', () => {
  it('returns the origin of a real URL directly, ignoring any opener', () => {
    const contents = { getURL: () => 'https://granted.example/page', opener: { url: 'https://other.example/' } }
    expect(appOrigin(originFromUrl, contents)).toBe('https://granted.example')
  })

  it('falls back to the opener\'s origin when its own URL has none (a popup still at about:blank)', () => {
    const contents = { getURL: () => 'about:blank', opener: { url: 'https://granted.example/page' } }
    expect(appOrigin(originFromUrl, contents)).toBe('https://granted.example')
  })

  it('returns null when there is no opener and the own URL has no origin', () => {
    const contents = { getURL: () => 'about:blank', opener: null }
    expect(appOrigin(originFromUrl, contents)).toBeNull()
  })

  // The finding this guards: `contents.opener.url` throws for an
  // already-destroyed opener WebContents (Electron) -- that must read as
  // "no opener", never propagate and crash the whole DevTools prompt.
  it('treats a destroyed opener (reading .url throws) the same as no opener at all', () => {
    const contents = {
      getURL: () => 'about:blank',
      opener: {
        get url (): string { throw new Error('Object has been destroyed') }
      }
    }
    expect(appOrigin(originFromUrl, contents)).toBeNull()
  })
})
