import { describe, expect, it, vi } from 'vitest'

vi.mock('../tab-factory.js', () => ({ BLANK_URL: 'about:blank' }))
vi.mock('../load-in-tab.js', () => ({ repartitionForTarget: vi.fn(() => false) }))
vi.mock('../tab-view.js', () => ({ EXIT_FULLSCREEN_WORLD_ID: 1001 }))

/** A fresh gate and a fresh `navigateTab` over it: the gate's state lasts as long as its module. */
async function setup (tabAlive = true) {
  vi.resetModules()
  const gate = await import('../../startup/web-ready.js')
  const { navigateTab } = await import('../tab-navigation.js')
  const loadURL = vi.fn(async (_url: string) => {})
  const openInternal = vi.fn()
  const viewSource = vi.fn(() => true)
  let alive = tabAlive
  const env = {
    record: () => alive ? { view: { webContents: { isDestroyed: () => false, loadURL } }, partition: undefined } : undefined,
    liveWebContents: () => undefined,
    openInternal,
    viewSource,
    searchUrl: (query: string) => `https://search.example/?q=${encodeURIComponent(query)}`
  } as unknown as Parameters<typeof navigateTab>[0]
  return { gate, navigate: (input: string) => { navigateTab(env, 'tab-1', input) }, loadURL, openInternal, viewSource, closeTab: () => { alive = false } }
}

describe('navigating a tab before web pages may load', () => {
  it('loads nothing for a web address, and loads it when the gate opens', async () => {
    const { gate, navigate, loadURL } = await setup()
    navigate('https://a.example/page')
    expect(loadURL).not.toHaveBeenCalled()

    gate.openWebContent()
    await vi.waitFor(() => { expect(loadURL).toHaveBeenCalledExactlyOnceWith('https://a.example/page') })
  })

  it('waits for a search as for an address: both are a load from the web', async () => {
    const { gate, navigate, loadURL } = await setup()
    navigate('some words')
    expect(loadURL).not.toHaveBeenCalled()
    gate.openWebContent()
    await vi.waitFor(() => { expect(loadURL).toHaveBeenCalledExactlyOnceWith('https://search.example/?q=some%20words') })
  })

  it('opens one of the shell\'s own pages at once, whatever its spelling', async () => {
    const { navigate, openInternal, loadURL } = await setup()
    navigate('orivon://settings/privacy')
    navigate('chrome://history')
    expect(openInternal.mock.calls).toEqual([['settings', '/privacy'], ['history', '/']])
    expect(loadURL).not.toHaveBeenCalled()
  })

  it('shows the source of a typed view-source: address only when the gate opens', async () => {
    const { gate, navigate, viewSource } = await setup()
    navigate('view-source:https://a.example/page')
    expect(viewSource).not.toHaveBeenCalled()
    gate.openWebContent()
    await vi.waitFor(() => { expect(viewSource).toHaveBeenCalledWith('https://a.example/page') })
  })

  it('does nothing for a tab that was closed while it waited', async () => {
    const { gate, navigate, loadURL, closeTab } = await setup()
    navigate('https://a.example/')
    closeTab()
    gate.openWebContent()
    await Promise.resolve()
    await Promise.resolve()
    expect(loadURL).not.toHaveBeenCalled()
  })

  it('navigates to the last address typed after the earlier ones, in order', async () => {
    const { gate, navigate, loadURL } = await setup()
    navigate('https://one.example/')
    navigate('https://two.example/')
    gate.openWebContent()
    await vi.waitFor(() => { expect(loadURL).toHaveBeenCalledTimes(2) })
    expect(loadURL.mock.calls.map((call) => call[0])).toEqual(['https://one.example/', 'https://two.example/'])
  })
})

describe('navigating a tab once web pages may load', () => {
  it('loads a web address at once', async () => {
    const { gate, navigate, loadURL } = await setup()
    gate.openWebContent()
    navigate('https://a.example/page')
    expect(loadURL).toHaveBeenCalledExactlyOnceWith('https://a.example/page')
  })
})
