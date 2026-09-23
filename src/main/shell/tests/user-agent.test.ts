import { describe, expect, it } from 'vitest'
import { chromeUserAgent } from '../user-agent.js'

describe('chromeUserAgent -- what every tab reports itself as', () => {
  it('is the plain Chrome string for Linux, with the reduced x.0.0.0 version Chrome itself sends', () => {
    expect(chromeUserAgent('152.0.7977.54', 'linux')).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
    )
  })

  it('uses the frozen platform tokens Chrome reports on Windows and macOS', () => {
    expect(chromeUserAgent('152.0.7977.54', 'win32')).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
    )
    expect(chromeUserAgent('152.0.7977.54', 'darwin')).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
    )
  })

  it('carries no Electron or orivon token, which is what is-electron checks and sign-in pages look for', () => {
    for (const platform of ['linux', 'win32', 'darwin', 'freebsd'] as const) {
      const ua = chromeUserAgent('152.0.7977.54', platform)
      expect(ua).not.toMatch(/electron/i)
      expect(ua).not.toMatch(/orivon/i)
    }
  })

  it('follows the Chromium it runs on, so it can never claim a Chrome older or newer than the engine', () => {
    expect(chromeUserAgent('160.1.2.3', 'linux')).toContain(' Chrome/160.0.0.0 ')
  })
})
