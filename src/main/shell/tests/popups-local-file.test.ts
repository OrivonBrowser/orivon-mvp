import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ WebContentsView: vi.fn() }))

const { windowOpenHandler, processWindowBudget } = await import('../popups.js')

type Host = Parameters<typeof windowOpenHandler>[0]
type Opener = ReturnType<Parameters<typeof windowOpenHandler>[1]>
type Details = Parameters<ReturnType<typeof windowOpenHandler>>[0]

const details = (url: string, disposition: Details['disposition'] = 'foreground-tab'): Details => ({
  url, frameName: '', features: '', disposition, referrer: { url: '', policy: 'default' }
})

const FILE_OPENER: Opener = { url: 'file:///home/u/app/index.html', partition: 'orivon-local-files' }
const WEB_OPENER: Opener = { url: 'https://news.example/story', partition: undefined }
const SIBLING = 'file:///home/u/app/other.html'

function hostWith (withOpenLocalFile = true) {
  const openLocalFile = vi.fn(() => undefined)
  const host: Host = {
    atCapacity: () => false,
    openTab: vi.fn(() => undefined),
    adoptPopup: vi.fn(),
    openBlobTab: vi.fn(() => undefined),
    openWindow: vi.fn(() => undefined),
    partitionFor: () => undefined,
    webPreferencesFor: () => ({}),
    isApp: () => false,
    ...(withOpenLocalFile ? { openLocalFile } : {})
  }
  return { host, openLocalFile }
}

describe('windowOpenHandler and a file: target', () => {
  it('opens a sibling from a local file in a new tab, and never gives the page a window of its own', () => {
    processWindowBudget.reset()
    const { host, openLocalFile } = hostWith()

    const result = windowOpenHandler(host, () => FILE_OPENER)(details(SIBLING))

    expect(result).toEqual({ action: 'deny' })
    expect(openLocalFile).toHaveBeenCalledWith(SIBLING, true)
    expect(host.openTab).not.toHaveBeenCalled()
    expect(host.adoptPopup).not.toHaveBeenCalled()
  })

  it('opens it behind the current tab for a middle click', () => {
    const { host, openLocalFile } = hostWith()
    windowOpenHandler(host, () => FILE_OPENER)(details(SIBLING, 'background-tab'))
    expect(openLocalFile).toHaveBeenCalledWith(SIBLING, false)
  })

  it('refuses a file from a web page, opening nothing', () => {
    const { host, openLocalFile } = hostWith()

    const result = windowOpenHandler(host, () => WEB_OPENER)(details(SIBLING))

    expect(result).toEqual({ action: 'deny' })
    expect(openLocalFile).not.toHaveBeenCalled()
    expect(host.openTab).not.toHaveBeenCalled()
  })

  it('refuses a file while a frame of the opener tab is a web page, since it may be the caller', () => {
    const { host, openLocalFile } = hostWith()

    const result = windowOpenHandler(host, () => ({ ...FILE_OPENER, hasWebFrame: true }))(details(SIBLING))

    expect(result).toEqual({ action: 'deny' })
    expect(openLocalFile).not.toHaveBeenCalled()
  })

  it.each([
    ['a host', 'file://server/share/a.html'],
    ['a // path', 'file:////server/share/a.html']
  ])('refuses %s even from a local file', (_name, url) => {
    const { host, openLocalFile } = hostWith()

    expect(windowOpenHandler(host, () => FILE_OPENER)(details(url))).toEqual({ action: 'deny' })
    expect(openLocalFile).not.toHaveBeenCalled()
    expect(host.openTab).not.toHaveBeenCalled()
  })

  it('denies when the shell supplies no way to open a local file', () => {
    const { host } = hostWith(false)

    expect(windowOpenHandler(host, () => FILE_OPENER)(details(SIBLING))).toEqual({ action: 'deny' })
    expect(host.openTab).not.toHaveBeenCalled()
  })

  it('leaves an https target from a local file on the ordinary route', () => {
    processWindowBudget.reset()
    const { host, openLocalFile } = hostWith()

    expect(windowOpenHandler(host, () => FILE_OPENER)(details('https://other.example/', 'new-window')).action).toBe('allow')
    windowOpenHandler(host, () => FILE_OPENER)(details('https://other.example/'))
    expect(host.openTab).toHaveBeenCalledWith('https://other.example/', true, undefined)
    expect(openLocalFile).not.toHaveBeenCalled()
  })
})
