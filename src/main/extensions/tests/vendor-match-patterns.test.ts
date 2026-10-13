import { describe, expect, it, vi } from 'vitest'

// UPSTREAM.md patch 72: the match helpers an extension's own patterns reach on every right-click and tabs.query.
vi.mock('electron', () => ({ BaseWindow: class {}, BrowserWindow: class {}, nativeImage: {} }))

const { matchesPattern, matchesTitlePattern } = await import('../../../../vendor/electron-chrome-extensions/src/browser/api/common.js')

describe('matchesPattern', () => {
  it('matches as a glob: * is any run, everything else is literal, the whole address must match', () => {
    expect(matchesPattern('https://example.com/*', 'https://example.com/a/b?c=1')).toBeTruthy()
    expect(matchesPattern('*://*.example.com/*', 'https://www.example.com/x')).toBeTruthy()
    expect(matchesPattern('https://example.com/a.b', 'https://example.com/a.b')).toBeTruthy()
    expect(matchesPattern('https://example.com/a.b', 'https://example.com/aXb')).toBeFalsy()
    expect(matchesPattern('https://example.com/', 'https://example.com/more')).toBeFalsy()
    expect(matchesPattern('https://example.com/(x)+[y]', 'https://example.com/(x)+[y]')).toBeTruthy()
    expect(matchesPattern('<all_urls>', 'https://anything.example/')).toBe(true)
  })

  it('answers a pattern built to backtrack at once, however long the address is', () => {
    const pattern = '*a'.repeat(10) + '*b'
    const url = 'https://example.com/' + 'a'.repeat(5000)
    const started = performance.now()
    expect(matchesPattern(pattern, url)).toBeFalsy()
    expect(performance.now() - started).toBeLessThan(50)
  })
})

describe('matchesTitlePattern', () => {
  it('matches a title as a glob', () => {
    expect(matchesTitlePattern('*Inbox*', 'Inbox (3) - Mail')).toBeTruthy()
    expect(matchesTitlePattern('Inbox', 'Inbox (3) - Mail')).toBeFalsy()
  })

  it('answers a pattern built to backtrack at once', () => {
    const started = performance.now()
    expect(matchesTitlePattern('*a'.repeat(10) + '*b', 'a'.repeat(5000))).toBeFalsy()
    expect(performance.now() - started).toBeLessThan(50)
  })
})
