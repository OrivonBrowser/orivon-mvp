// waitForChromeView and waitForChromeReady against fake pages: no Electron is launched.
import { describe, expect, it } from 'vitest'
import { waitForChromeReady, waitForChromeView } from './smoke-helpers.mjs'

const CHROME_URL = 'file:///app/out/renderer/index.html'
const page = (url: string, reads: Array<string | null> = []): { url: () => string, evaluate: () => Promise<string | null> } => {
  let n = 0
  return { url: () => url, evaluate: async () => reads[Math.min(n++, reads.length - 1)] ?? null }
}

describe('waitForChromeView', () => {
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
