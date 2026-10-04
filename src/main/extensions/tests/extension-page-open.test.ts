import { describe, expect, it, vi } from 'vitest'

const pages: Array<{ url: string, type: string, destroyed?: boolean }> = []
vi.mock('electron', () => ({
  webContents: {
    getAllWebContents: () => pages.map((page) => ({ isDestroyed: () => page.destroyed === true, getType: () => page.type, getURL: () => page.url }))
  }
}))

const { extensionPageOpen } = await import('../extension-page-open.js')

const ID = 'a'.repeat(32)

describe('extensionPageOpen', () => {
  it('is true while a tab or popup shows a page of the extension', () => {
    pages.length = 0
    pages.push({ url: `chrome-extension://${ID}/options.html`, type: 'window' })
    expect(extensionPageOpen(ID)).toBe(true)
    expect(extensionPageOpen('b'.repeat(32))).toBe(false)
  })

  it('does not count an MV2 background page, which lives as long as the extension', () => {
    pages.length = 0
    pages.push({ url: `chrome-extension://${ID}/_generated_background_page.html`, type: 'backgroundPage' })
    expect(extensionPageOpen(ID)).toBe(false)
  })

  it('ignores a destroyed page', () => {
    pages.length = 0
    pages.push({ url: `chrome-extension://${ID}/popup.html`, type: 'window', destroyed: true })
    expect(extensionPageOpen(ID)).toBe(false)
  })
})
