import { describe, expect, it, vi } from 'vitest'
import { goHome, homeAddress } from '../home.js'

interface Tab { id: string, isNewTab: boolean }

function setup (homeUrl: string, tabs: Tab[], activeTabId: string | null, tunnel?: string): { navigate: ReturnType<typeof vi.fn>, createTab: ReturnType<typeof vi.fn>, go: (newTab: boolean) => void } {
  const navigate = vi.fn()
  const createTab = vi.fn()
  const settings = { get: (key: string) => (key === 'home.url' ? homeUrl : undefined) } as never
  const manager = { getState: () => ({ tabs, activeTabId }), navigate, createTab, newTabTunnelChoice: () => tunnel } as never
  return { navigate, createTab, go: (newTab) => { goHome(manager, settings, { newTab }) } }
}

const page = { id: 'a', isNewTab: false }
const dashboard = { id: 'd', isNewTab: true }

describe('homeAddress', () => {
  it('resolves the text as the address bar would', () => {
    expect(homeAddress({ get: () => 'example.com' } as never)).toBe('https://example.com/')
    expect(homeAddress({ get: () => 'https://example.com/start' } as never)).toBe('https://example.com/start')
  })

  it('is null for nothing, and for text that is not an address', () => {
    expect(homeAddress({ get: () => '' } as never)).toBeNull()
    expect(homeAddress({ get: () => 'javascript:alert(1)' } as never)).toBeNull()
    expect(homeAddress({ get: () => 'data:text/html,hi' } as never)).toBeNull()
    expect(homeAddress({ get: () => 'some words to search' } as never)).toBeNull()
  })
})

describe('goHome with a home page', () => {
  it('loads it in the active tab', () => {
    const { navigate, createTab, go } = setup('example.com', [page], 'a')
    go(false)
    expect(navigate).toHaveBeenCalledWith('a', 'https://example.com/')
    expect(createTab).not.toHaveBeenCalled()
  })

  it('opens it in a new background tab for a middle click', () => {
    const { navigate, createTab, go } = setup('example.com', [page], 'a')
    go(true)
    expect(createTab).toHaveBeenCalledWith('https://example.com/', false, undefined, undefined)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('opens a tab of its own when there is no active tab', () => {
    const { createTab, go } = setup('example.com', [], null)
    go(false)
    expect(createTab).toHaveBeenCalledWith('https://example.com/')
  })
})

describe('goHome with no home page', () => {
  it('opens the new tab page from a loaded page, and never swaps the page for it', () => {
    const { navigate, createTab, go } = setup('', [page], 'a')
    go(false)
    expect(createTab).toHaveBeenCalledWith(undefined, true, undefined, undefined)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('does nothing from the new tab page itself', () => {
    const { navigate, createTab, go } = setup('', [page, dashboard], 'd')
    go(false)
    expect(createTab).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('always opens a new tab page for a middle click, in the background', () => {
    const { createTab, go } = setup('', [dashboard], 'd')
    go(true)
    expect(createTab).toHaveBeenCalledWith(undefined, false, undefined, undefined)
  })
})

describe('goHome from a tab that gives a new tab a tunnel', () => {
  it('opens the home page in a new tab on that tunnel, and the new-tab page too', () => {
    const withAddress = setup('example.com', [page], 'a', 'nym')
    withAddress.go(true)
    expect(withAddress.createTab).toHaveBeenCalledWith('https://example.com/', false, undefined, 'nym')
    const blank = setup('', [page], 'a', 'socks5')
    blank.go(true)
    expect(blank.createTab).toHaveBeenCalledWith(undefined, false, undefined, 'socks5')
    const swapped = setup('', [page], 'a', 'nym')
    swapped.go(false)
    expect(swapped.createTab).toHaveBeenCalledWith(undefined, true, undefined, 'nym')
  })

  it('loads the home page in the active tab as before, whatever the tunnel', () => {
    const { navigate, createTab, go } = setup('example.com', [page], 'a', 'nym')
    go(false)
    expect(navigate).toHaveBeenCalledWith('a', 'https://example.com/')
    expect(createTab).not.toHaveBeenCalled()
  })
})
