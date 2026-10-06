// The chrome waits against fake pages: no Electron is launched.
import { describe, expect, it } from 'vitest'
import { isChromeUrl, waitForChromeDrawn, waitForChromeReady, waitForChromeView } from './smoke-helpers.mjs'

const CHROME_URL = 'file:///app/out/renderer/index.html'
const page = (url: string, reads: Array<string | null> = []): { url: () => string, evaluate: () => Promise<string | null> } => {
  let n = 0
  return { url: () => url, evaluate: async () => reads[Math.min(n++, reads.length - 1)] ?? null }
}

describe('isChromeUrl', () => {
  it('knows the built chrome page and, with a dev server named, its root, and nothing else', () => {
    expect(isChromeUrl(CHROME_URL, undefined)).toBe(true)
    expect(isChromeUrl('http://127.0.0.1:5199/', undefined)).toBe(false)
    expect(isChromeUrl('http://127.0.0.1:5199/', 'http://127.0.0.1:5199')).toBe(true)
    expect(isChromeUrl('http://127.0.0.1:5199', 'http://127.0.0.1:5199/')).toBe(true)
    expect(isChromeUrl('http://127.0.0.1:5199/newtab/index.html', 'http://127.0.0.1:5199')).toBe(false)
  })
})

describe('waitForChromeView', () => {
  it('finds a dev server root as the chrome when the launch names the dev server', async () => {
    const chrome = page('http://127.0.0.1:5199/')
    expect(await waitForChromeView({ windows: () => [page('orivon://private'), chrome] }, 1_000, 'http://127.0.0.1:5199')).toBe(chrome)
  })

  it('returns the chrome page once it is listed, not a page that only has the same window count', async () => {
    const windows = [page('chrome-extension://abc/background.html')]
    const chrome = page(CHROME_URL)
    setTimeout(() => { windows.push(chrome) }, 150)
    expect(await waitForChromeView({ windows: () => windows }, 3_000)).toBe(chrome)
  })

  it('gives up with undefined when no chrome page is ever listed', async () => {
    expect(await waitForChromeView({ windows: () => [page('orivon://newtab')] }, 200)).toBeUndefined()
  })
})

describe('waitForChromeReady', () => {
  it('waits through reads with no frame or no tab drawn, then needs the boxes to hold still', async () => {
    const view = page(CHROME_URL, [null, null, '1,2,3,4;5,6,7,8', '1,2,3,4;5,6,7,9', '1,2,3,4;5,6,7,9', '1,2,3,4;5,6,7,9'])
    expect(await waitForChromeReady(view, 3_000)).toBe(true)
  })

  it('is not ready while the boxes keep moving, or while nothing is drawn', async () => {
    let n = 0
    const moving = { url: () => CHROME_URL, evaluate: async () => `${String(n++)},0,0,0;0,0,0,0` }
    expect(await waitForChromeReady(moving, 400)).toBe(false)
    expect(await waitForChromeReady(page(CHROME_URL, [null]), 400)).toBe(false)
  })
})

describe('waitForChromeDrawn', () => {
  it('needs a drawn tab but no frame, and gives up when none is drawn', async () => {
    expect(await waitForChromeDrawn({ evaluate: async () => true }, 1_000)).toBe(true)
    expect(await waitForChromeDrawn({ evaluate: async () => false }, 200)).toBe(false)
  })

  it('counts a page that never answers as not drawn, within the read bound, instead of hanging on it', async () => {
    const started = Date.now()
    expect(await waitForChromeDrawn({ evaluate: async () => await new Promise<boolean>(() => {}) }, 200)).toBe(false)
    expect(Date.now() - started).toBeLessThan(8_000)
  })
})
