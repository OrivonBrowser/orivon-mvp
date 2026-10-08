import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ WebContentsView: vi.fn() }))

const { windowOpenHandler, processWindowBudget } = await import('../popups.js')

type Host = Parameters<typeof windowOpenHandler>[0]
type Details = Parameters<ReturnType<typeof windowOpenHandler>>[0]

const details = (url: string, features = ''): Details => ({
  url, frameName: '', features, disposition: 'foreground-tab', referrer: { url: '', policy: 'default' }
})

const OPENER = { url: 'https://news.example/story', partition: undefined }

function hostWith (withGate = true) {
  const openTab = vi.fn(() => undefined)
  const openExternal = vi.fn()
  const host: Host = {
    atCapacity: () => false,
    openTab,
    adoptPopup: vi.fn(),
    openBlobTab: vi.fn(() => undefined),
    openWindow: vi.fn(() => undefined),
    partitionFor: () => undefined,
    webPreferencesFor: () => ({}),
    isApp: () => false,
    ...(withGate ? { openExternal } : {})
  }
  return { host, openTab, openExternal }
}

describe('windowOpenHandler and an address another program handles', () => {
  it.each([
    ['mailto:someone@example.com', 'noopener,noreferrer'],
    ['magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567', ''],
    ['bitcoin:bc1qexample?amount=1', 'noopener']
  ])('hands %s to the external-link question and opens no tab', (url, features) => {
    processWindowBudget.reset()
    const { host, openTab, openExternal } = hostWith()
    expect(windowOpenHandler(host, () => OPENER)(details(url, features)).action).toBe('deny')
    expect(openExternal).toHaveBeenCalledWith(url)
    expect(openTab).not.toHaveBeenCalled()
  })

  it('opens a web address as a tab and asks nothing', () => {
    processWindowBudget.reset()
    const { host, openTab, openExternal } = hostWith()
    windowOpenHandler(host, () => OPENER)(details('https://example.com/', 'noopener,noreferrer'))
    expect(openExternal).not.toHaveBeenCalled()
    expect(openTab).toHaveBeenCalledOnce()
  })

  it('still refuses without opening a tab when no gate is wired', () => {
    processWindowBudget.reset()
    const { host, openTab } = hostWith(false)
    expect(windowOpenHandler(host, () => OPENER)(details('mailto:someone@example.com')).action).toBe('deny')
    expect(openTab).not.toHaveBeenCalled()
  })
})
