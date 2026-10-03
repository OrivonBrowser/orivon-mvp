import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { activateTabShowing, type WindowWithTabs } from '../extension-options-tab.js'
import { markExtensionOpened } from '../extension-opened-pages.js'

const ID = 'b'.repeat(32)
const URL = `chrome-extension://${ID}/options.html`

function page (url: string, opened: boolean): WebContents {
  const contents = { getURL: () => url, on: vi.fn() } as unknown as WebContents
  if (opened) markExtensionOpened(contents, url)
  return contents
}

function windowWith (pages: Record<string, WebContents>, destroyed = false): WindowWithTabs & { activateTab: ReturnType<typeof vi.fn>, focus: ReturnType<typeof vi.fn> } {
  const activateTab = vi.fn()
  const focus = vi.fn()
  return {
    window: { focus, isDestroyed: () => destroyed },
    tabs: { ids: () => Object.keys(pages), liveWebContents: (id) => pages[id], activateTab },
    activateTab,
    focus
  }
}

describe('activateTabShowing', () => {
  it('brings the tab already on the page to the front, in whichever window holds it', () => {
    const first = windowWith({ a: page('https://x.example/', false) })
    const second = windowWith({ b: page('https://y.example/', false), c: page(URL, true) })
    expect(activateTabShowing([first, second], URL)).toBe(true)
    expect(second.activateTab).toHaveBeenCalledWith('c')
    expect(second.focus).toHaveBeenCalled()
    expect(first.activateTab).not.toHaveBeenCalled()
  })

  it('finds nothing when no tab shows it, or when the tab on that address was not opened by the host', () => {
    const window = windowWith({ a: page('https://x.example/', false), b: page(URL, false) })
    expect(activateTabShowing([window], URL)).toBe(false)
    expect(window.activateTab).not.toHaveBeenCalled()
  })

  it('leaves a window that is gone and an address that is not an extension page alone', () => {
    const gone = windowWith({ a: page(URL, true) }, true)
    expect(activateTabShowing([gone], URL)).toBe(false)
    expect(activateTabShowing([windowWith({ a: page('https://x.example/', true) })], 'https://x.example/')).toBe(false)
  })
})
