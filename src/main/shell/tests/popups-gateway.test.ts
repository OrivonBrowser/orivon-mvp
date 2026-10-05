import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ WebContentsView: vi.fn() }))

const { windowOpenHandler, processWindowBudget } = await import('../popups.js')

type Host = Parameters<typeof windowOpenHandler>[0]
type Details = Parameters<ReturnType<typeof windowOpenHandler>>[0]

const details = (url: string, disposition: Details['disposition'] = 'foreground-tab'): Details => ({
  url, frameName: '', features: '', disposition, referrer: { url: '', policy: 'default' }
})

const OPENER = { url: 'https://news.example/story', partition: undefined }

function hostWith (gatewayTarget?: Host['gatewayTarget']) {
  const openTab = vi.fn(() => undefined)
  const host: Host = {
    atCapacity: () => false,
    openTab,
    adoptPopup: vi.fn(),
    openBlobTab: vi.fn(() => undefined),
    openWindow: vi.fn(() => undefined),
    partitionFor: () => undefined,
    webPreferencesFor: () => ({}),
    isApp: () => false,
    ...(gatewayTarget === undefined ? {} : { gatewayTarget })
  }
  return { host, openTab }
}

describe('windowOpenHandler and a gateway address', () => {
  const gateway = (url: string): string | undefined => (url.startsWith('https://site.eth.limo/') ? 'https://site.eth/' : undefined)

  it('opens a link to a gateway address as a new tab, which maps it, instead of adopting a popup in the opener\'s session', () => {
    processWindowBudget.reset()
    const { host, openTab } = hostWith(gateway)
    expect(windowOpenHandler(host, () => OPENER)(details('https://site.eth.limo/page')).action).toBe('deny')
    expect(openTab).toHaveBeenCalledWith('https://site.eth.limo/page', true, undefined)
  })

  it('opens a sized popup to a gateway address as a tab too', () => {
    processWindowBudget.reset()
    const { host, openTab } = hostWith(gateway)
    const result = windowOpenHandler(host, () => OPENER)({ ...details('https://site.eth.limo/page', 'new-window'), features: 'width=500,height=600' })
    expect(result.action).toBe('deny')
    expect(openTab).toHaveBeenCalledTimes(1)
  })

  it('adopts an ordinary popup as before', () => {
    processWindowBudget.reset()
    const { host } = hostWith(gateway)
    expect(windowOpenHandler(host, () => OPENER)(details('https://other.example/', 'new-window')).action).toBe('allow')
  })
})
