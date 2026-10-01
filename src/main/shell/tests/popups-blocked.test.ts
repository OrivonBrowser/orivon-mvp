import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ WebContentsView: vi.fn() }))

const { windowOpenHandler, processWindowBudget } = await import('../popups.js')

type Host = Parameters<typeof windowOpenHandler>[0]
type Details = Parameters<ReturnType<typeof windowOpenHandler>>[0]

const details = (url: string): Details => ({
  url, frameName: '', features: '', disposition: 'foreground-tab', referrer: { url: '', policy: 'default' }
})

function hostWith (popupBlocked?: Host['popupBlocked']) {
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
    ...(popupBlocked === undefined ? {} : { popupBlocked })
  }
  return { host, openTab }
}

const OPENER = { url: 'https://news.example/story', partition: undefined }

describe('windowOpenHandler and the pop-up blocker', () => {
  it('denies a refused open without opening a tab or a window', () => {
    processWindowBudget.reset()
    const { host, openTab } = hostWith(() => true)
    const result = windowOpenHandler(host, () => OPENER)(details('https://ads.example/'))
    expect(result).toEqual({ action: 'deny' })
    expect(openTab).not.toHaveBeenCalled()
    expect(host.openWindow).not.toHaveBeenCalled()
  })

  it('hands the blocker the details and the opener it is asked about', () => {
    const blocked = vi.fn(() => true)
    const { host } = hostWith(blocked)
    const asked = details('https://ads.example/')
    windowOpenHandler(host, () => OPENER)(asked)
    expect(blocked).toHaveBeenCalledWith(asked, OPENER)
  })

  it('goes on as before when the blocker lets the open through', () => {
    processWindowBudget.reset()
    const { host } = hostWith(() => false)
    const result = windowOpenHandler(host, () => OPENER)(details('https://pay.example/'))
    expect(result.action).toBe('allow')
  })

  it('goes on as before when no blocker is wired', () => {
    processWindowBudget.reset()
    const { host } = hostWith()
    expect(windowOpenHandler(host, () => OPENER)(details('https://pay.example/')).action).toBe('allow')
  })

  it('refuses at capacity before the blocker is asked, so a refusal is never recorded for it', () => {
    const blocked = vi.fn(() => true)
    const { host } = hostWith(blocked)
    const full: Host = { ...host, atCapacity: () => true }
    expect(windowOpenHandler(full, () => OPENER)(details('https://a.example/'))).toEqual({ action: 'deny' })
    expect(blocked).not.toHaveBeenCalled()
  })
})
