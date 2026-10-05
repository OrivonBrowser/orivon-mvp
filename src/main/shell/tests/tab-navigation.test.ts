import { describe, expect, it, vi } from 'vitest'

vi.mock('../tab-factory.js', () => ({ BLANK_URL: 'about:blank' }))
vi.mock('../tab-parking.js', () => ({ repartitionView: vi.fn() }))
vi.mock('../tab-view.js', () => ({
  appTabFlagChanged: () => false,
  partitionChanged: () => undefined,
  EXIT_FULLSCREEN_WORLD_ID: 1001
}))

const { navigateTab, reloadTab } = await import('../tab-navigation.js')
type Env = Parameters<typeof navigateTab>[0]

function setup (gatewayTarget?: (url: string) => string | undefined): { navigate: (input: string) => void, openInternal: ReturnType<typeof vi.fn>, viewSource: ReturnType<typeof vi.fn>, loadURL: ReturnType<typeof vi.fn> } {
  const loadURL = vi.fn(async () => {})
  const openInternal = vi.fn()
  const viewSource = vi.fn(() => true)
  const env = {
    record: () => ({ view: { webContents: { isDestroyed: () => false, loadURL } }, partition: undefined }),
    liveWebContents: () => undefined,
    openInternal,
    viewSource,
    broker: () => undefined,
    searchUrl: (query: string) => `https://search.example/?q=${encodeURIComponent(query)}`,
    ...(gatewayTarget === undefined ? {} : { gatewayTarget })
  } as unknown as Env
  return { navigate: (input) => { navigateTab(env, 'tab-1', input) }, openInternal, viewSource, loadURL }
}

describe('typing into the address bar', () => {
  it('opens Orivon\'s page for an about: or chrome:// name other browsers use', () => {
    const { navigate, openInternal, loadURL } = setup()
    navigate('about:version')
    navigate('chrome://gpu')
    navigate('chrome://history')
    expect(openInternal.mock.calls).toEqual([['about', '/'], ['about', '/gpu'], ['history', '/']])
    expect(loadURL).not.toHaveBeenCalled()
  })

  it('still opens an orivon:// address', () => {
    const { navigate, openInternal } = setup()
    navigate('orivon://settings/privacy')
    expect(openInternal).toHaveBeenCalledWith('settings', '/privacy')
  })

  it('leaves about:blank refused and a name Orivon has no page for a search, as before', () => {
    const { navigate, openInternal, loadURL } = setup()
    navigate('about:blank')
    navigate('chrome://net-internals')
    expect(openInternal).not.toHaveBeenCalled()
    expect(loadURL.mock.calls.map((call) => call[0])).toEqual(['about:blank', 'https://search.example/?q=chrome%3A%2F%2Fnet-internals'])
  })

  it('shows the source of a typed view-source: web address, and loads nothing itself', () => {
    const { navigate, viewSource, loadURL } = setup()
    navigate('view-source:https://a.example/page')
    expect(viewSource).toHaveBeenCalledWith('https://a.example/page')
    expect(loadURL).not.toHaveBeenCalled()
  })

  it('does not swallow the input when no source tab could be opened', () => {
    const { navigate, viewSource, loadURL } = setup()
    viewSource.mockReturnValueOnce(false)
    navigate('view-source:https://a.example/page')
    expect(viewSource).toHaveBeenCalledTimes(1)
    expect(loadURL).toHaveBeenCalledTimes(1)
    expect(String(loadURL.mock.calls[0]?.[0])).not.toMatch(/^view-source:/i)
  })

  it('treats view-source: of anything else as it always did: a search, never a view-source load', () => {
    const { navigate, viewSource, loadURL } = setup()
    navigate('view-source:javascript:1')
    navigate('view-source:file:///etc/passwd')
    expect(viewSource).not.toHaveBeenCalled()
    for (const call of loadURL.mock.calls) expect(String(call[0])).not.toMatch(/^(view-source|javascript|file):/i)
  })
})

describe('typing a gateway address', () => {
  const target = (url: string): string | undefined => (url.startsWith('https://site.eth.limo/') ? url.replace('site.eth.limo', 'site.eth') : undefined)

  it('opens the .eth address with its path, query and fragment kept', () => {
    const { navigate, loadURL } = setup(target)
    navigate('site.eth.limo/page.html?q=1#f')
    expect(loadURL).toHaveBeenCalledExactlyOnceWith('https://site.eth/page.html?q=1#f')
  })

  it('loads the gateway as typed when nothing maps it', () => {
    const { navigate, loadURL } = setup()
    navigate('site.eth.limo/page.html?q=1#f')
    expect(loadURL).toHaveBeenCalledExactlyOnceWith('https://site.eth.limo/page.html?q=1#f')
  })

  it('leaves a typed address the mapping does not know alone', () => {
    const { navigate, loadURL } = setup(target)
    navigate('example.com/x')
    expect(loadURL).toHaveBeenCalledExactlyOnceWith('https://example.com/x')
  })
})

describe('reload while a page is loading', () => {
  function loading (opts: { loadingMain: boolean, inflightUrl?: string, active?: string }): { reload: () => void, wcReload: ReturnType<typeof vi.fn>, loadURL: ReturnType<typeof vi.fn> } {
    const wcReload = vi.fn()
    const loadURL = vi.fn(async () => {})
    const wc = {
      isDestroyed: () => false,
      isLoadingMainFrame: () => opts.loadingMain,
      reload: wcReload,
      loadURL,
      navigationHistory: { getActiveIndex: () => (opts.active === undefined ? -1 : 0), getEntryAtIndex: (index: number) => (index === 0 ? { url: opts.active } : null) }
    }
    const env = {
      record: () => ({ view: { webContents: wc }, partition: undefined, inflightUrl: opts.inflightUrl }),
      liveWebContents: () => wc,
      openInternal: vi.fn(),
      viewSource: vi.fn(),
      broker: () => undefined,
      searchUrl: undefined
    } as unknown as Env
    return { reload: () => { reloadTab(env, 'tab-1') }, wcReload, loadURL }
  }

  it('restarts the load that has not committed, instead of reloading the page before it', () => {
    const { reload, wcReload, loadURL } = loading({ loadingMain: true, inflightUrl: 'https://slow.example/next', active: 'https://old.example/' })
    reload()
    expect(loadURL).toHaveBeenCalledWith('https://slow.example/next')
    expect(wcReload).not.toHaveBeenCalled()
  })

  it('reloads a committed page that is still loading its subresources', () => {
    const { reload, wcReload, loadURL } = loading({ loadingMain: true, active: 'https://old.example/' })
    reload()
    expect(wcReload).toHaveBeenCalledTimes(1)
    expect(loadURL).not.toHaveBeenCalled()
  })

  it('reloads when nothing is loading', () => {
    const { reload, wcReload, loadURL } = loading({ loadingMain: false, inflightUrl: 'https://stale.example/' })
    reload()
    expect(wcReload).toHaveBeenCalledTimes(1)
    expect(loadURL).not.toHaveBeenCalled()
  })

  it('reloads the page itself when the load in flight is for the address already shown', () => {
    const { reload, wcReload, loadURL } = loading({ loadingMain: true, inflightUrl: 'https://same.example/', active: 'https://same.example/' })
    reload()
    expect(wcReload).toHaveBeenCalledTimes(1)
    expect(loadURL).not.toHaveBeenCalled()
  })

  it.each(['file:///etc/passwd', 'data:text/html,hi', 'javascript:alert(1)', 'orivon://settings/', 'about:blank'])(
    'never sends the in-flight address %s through the address bar\'s path',
    (inflightUrl) => {
      const { reload, wcReload, loadURL } = loading({ loadingMain: true, inflightUrl, active: 'https://old.example/' })
      reload()
      expect(loadURL).not.toHaveBeenCalled()
      expect(wcReload).toHaveBeenCalledTimes(1)
    }
  )
})
