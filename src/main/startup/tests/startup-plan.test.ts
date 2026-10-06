import { describe, expect, it } from 'vitest'
import type { SavedSession, SavedWindow } from '../../session-restore/session-types.js'
import { parsePages, planOpensLocalFile, planStartup, shouldOfferRestore, usableWindows } from '../startup-plan.js'
import type { StartupInput } from '../startup-plan.js'

const window = (urls: string[], pinned = false): SavedWindow => ({
  bounds: { x: 0, y: 0, width: 800, height: 600 }, maximized: false, active: 0,
  tabs: urls.map((url) => ({ url, title: '', pinned }))
})
const session = (windows: SavedWindow[], clean = true): SavedSession => ({ version: 1, clean, windows })
const input = (over: Partial<StartupInput> = {}): StartupInput =>
  ({ mode: 'newTab', pages: '', argvUrls: [], previous: null, isPrivate: false, ...over })

describe('parsePages', () => {
  it('keeps the addresses the address bar would load, as it would load them', () => {
    expect(parsePages('example.com\nhttps://b.example/x')).toEqual(['https://example.com/', 'https://b.example/x'])
  })

  it('skips blank lines, junk and a refused scheme', () => {
    expect(parsePages('\n  \nnot a url at all\njavascript:alert(1)\ndata:text/html,x\nhttps://ok.example/\n')).toEqual(['https://ok.example/'])
  })

  it('skips a page already listed, whatever its spelling', () => {
    expect(parsePages('example.com\nhttps://example.com/\nEXAMPLE.com')).toEqual(['https://example.com/'])
  })

  it('stops at eight', () => {
    const lines = Array.from({ length: 10 }, (_, n) => `https://${String(n)}.example/`).join('\n')
    expect(parsePages(lines)).toHaveLength(8)
    expect(parsePages(lines).at(-1)).toBe('https://7.example/')
  })
})

describe('planStartup', () => {
  const previous = session([window(['https://a.example/', 'https://b.example/'], true), window(['https://c.example/'])])

  it('opens the new tab page for the default choice, whatever the last session held', () => {
    expect(planStartup(input({ previous }))).toEqual({ first: { tabs: [], urls: [] }, more: [] })
  })

  it('continues with every window of the last session: the first here, the rest after', () => {
    const plan = planStartup(input({ mode: 'continue', previous }))
    expect(plan.first.saved).toBe(previous.windows[0])
    expect(plan.first.tabs).toBe(previous.windows[0]?.tabs)
    expect(plan.more).toEqual([previous.windows[1]])
  })

  it('opens the new tab page when continuing with no session, or none with a tab in it', () => {
    expect(planStartup(input({ mode: 'continue' }))).toEqual({ first: { tabs: [], urls: [] }, more: [] })
    expect(planStartup(input({ mode: 'continue', previous: session([window([])]) })).first.saved).toBeUndefined()
  })

  it('skips a saved window with no tab left to open, keeping the order of the others', () => {
    const plan = planStartup(input({ mode: 'continue', previous: session([window([]), window(['https://x.example/']), window(['https://y.example/'])]) }))
    expect(plan.first.tabs.map((tab) => tab.url)).toEqual(['https://x.example/'])
    expect(plan.more).toHaveLength(1)
  })

  it('opens the listed pages as tabs, and nothing of the session', () => {
    const plan = planStartup(input({ mode: 'pages', pages: 'https://p.example/\nnonsense here\nhttps://q.example/', previous }))
    expect(plan.first.tabs.map((tab) => tab.url)).toEqual(['https://p.example/', 'https://q.example/'])
    expect(plan.first.saved).toBeUndefined()
    expect(plan.more).toEqual([])
  })

  it('falls back to the new tab page for an empty or useless list', () => {
    expect(planStartup(input({ mode: 'pages' })).first.tabs).toEqual([])
    expect(planStartup(input({ mode: 'pages', pages: 'javascript:alert(1)' })).first.tabs).toEqual([])
  })

  it('adds the addresses on the command line after whatever the choice opens', () => {
    const urls = ['https://link.example/']
    expect(planStartup(input({ mode: 'continue', previous, argvUrls: urls })).first.urls).toBe(urls)
    expect(planStartup(input({ mode: 'pages', pages: 'https://p.example/', argvUrls: urls })).first.urls).toBe(urls)
    expect(planStartup(input({ argvUrls: urls })).first.urls).toBe(urls)
  })

  it('ignores the choice in a private session, keeping only its own address', () => {
    const urls = ['https://link.example/']
    for (const mode of ['continue', 'pages'] as const) {
      expect(planStartup(input({ mode, pages: 'https://p.example/', previous, isPrivate: true, argvUrls: urls })))
        .toEqual({ first: { tabs: [], urls }, more: [] })
    }
  })
})

describe('usableWindows', () => {
  it('drops the windows with no tab and copes with no session', () => {
    expect(usableWindows(null)).toEqual([])
    expect(usableWindows(session([window([]), window(['https://a.example/'])]))).toHaveLength(1)
  })
})

describe('shouldOfferRestore', () => {
  const crashed = session([window(['https://a.example/'])], false)

  it('offers the session after a run that did not end cleanly', () => {
    expect(shouldOfferRestore('newTab', crashed, false)).toBe(true)
    expect(shouldOfferRestore('pages', crashed, false)).toBe(true)
  })

  it('does not when the choice already brings it back, when the run ended well, or in a private session', () => {
    expect(shouldOfferRestore('continue', crashed, false)).toBe(false)
    expect(shouldOfferRestore('newTab', session([window(['https://a.example/'])]), false)).toBe(false)
    expect(shouldOfferRestore('newTab', crashed, true)).toBe(false)
  })

  it('does not when there was no session or nothing in it to bring back', () => {
    expect(shouldOfferRestore('newTab', null, false)).toBe(false)
    expect(shouldOfferRestore('newTab', session([window([])], false), false)).toBe(false)
  })
})

describe('planOpensLocalFile', () => {
  it('is false for a plan of web addresses and the shell\'s own pages', () => {
    expect(planOpensLocalFile(planStartup(input({ argvUrls: ['https://a.example/'] })))).toBe(false)
  })

  it('is true for a launch address, a restored tab or a tab of a later window that is a local file', () => {
    expect(planOpensLocalFile(planStartup(input({ argvUrls: ['file:///tmp/a.html'] })))).toBe(true)
    expect(planOpensLocalFile(planStartup(input({ mode: 'continue', previous: session([window(['https://a.example/', 'file:///tmp/a.html'])]) })))).toBe(true)
    expect(planOpensLocalFile(planStartup(input({ mode: 'continue', previous: session([window(['https://a.example/']), window(['file:///tmp/a.html'])]) })))).toBe(true)
  })

  it('is false when a tab only has a local file behind it in its history', () => {
    const tab = { url: 'https://a.example/', title: '', pinned: false, entries: [{ url: 'file:///tmp/a.html', title: '' }, { url: 'https://a.example/', title: '' }], index: 1 }
    const previous = session([{ ...window([]), tabs: [tab] }])
    expect(planOpensLocalFile(planStartup(input({ mode: 'continue', previous })))).toBe(false)
  })
})
